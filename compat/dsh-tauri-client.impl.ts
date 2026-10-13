import type { LifecycleController, RegisterCleanup, RegisterSetup } from './dsh-tauri-types'
import { defineStore, useStore } from 'valtio-define'

export { defineStore, useStore }
export type * from './dsh-tauri-types'

/** 未安装时的兜底语言：与核心 `FALLBACK_LOCALE` 一致。 */
const FALLBACK_LOCALE = 'en'

// --- 请求 ---

/**
 * `dsh-tauri/client` 的 ofetch 选项面。
 *
 * 只声明本插件真正用到的四个字段：真实实现是 ofetch 的 `FetchOptions`，
 * 独立仓库不引入 ofetch（宿主注入的模块里才有），这里用手写结构面替代。
 */
export interface FetchOptions {
  baseURL?: string
  method?: string
  body?: unknown
  params?: unknown
  [key: string]: unknown
}

/** JSON 响应优先解码；非 JSON 纯文本错误体保留原文。 */
export function parseJsonResponse(text: string): unknown {
  if (text.length === 0)
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    return text
  }
}

/** 非 2xx 默认错误信息：优先取响应体 error / message / statusMessage，否则回退状态码文案。 */
export function defaultErrorMessage(status: number, body: unknown): string {
  const text = typeof body === 'string'
    ? body
    : body && typeof body === 'object'
      ? readErrorText(body as Record<string, unknown>)
      : ''
  return text ? `请求失败 (${status}): ${text}` : `请求失败 (${status})`
}

function readErrorText(body: Record<string, unknown>): string {
  for (const key of ['error', 'message', 'statusMessage'] as const) {
    const value = body[key]
    if (typeof value === 'string' && value.length > 0)
      return value
  }
  return ''
}

/**
 * 垫片里的 ofetch 只在单元测试被顶替后使用：client-mock 用 wire 协议替换了它。
 * 真运行时 `dsh-tauri/client` 由宿主注入，这里直接失败，避免测试漏掉 mock 时静默出网。
 */
export function ofetch<T = unknown>(path: string, _options?: FetchOptions): Promise<T> {
  return Promise.reject(new Error(`dsh-tauri/client 垫片不发起真实请求：${path}`))
}

// --- 样式与工具 ---

/** 类名拼接：字符串原样收下，对象按真值决定是否展开（够本插件用，等价真实实现的常用面）。 */
export function cn(...args: unknown[]): string {
  const classes: string[] = []
  for (const entry of args) {
    if (typeof entry === 'string') {
      classes.push(entry)
    }
    else if (entry !== null && typeof entry === 'object') {
      for (const [key, active] of Object.entries(entry)) {
        if (active === true)
          classes.push(key)
      }
    }
  }
  return classes.join(' ')
}

/** 去重保序。 */
export function uniq<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

// --- 生命周期 ---

/** 创建受控生命周期控制器：登记的一切资源都由它统一回收。 */
export function createLifecycleController(): LifecycleController {
  const cleanups: RegisterCleanup[] = []
  let disposed = false

  return {
    add(cleanup) {
      if (disposed) {
        cleanup()
        return
      }
      cleanups.push(cleanup)
    },
    timeout(run, ms) {
      const timer = setTimeout(run, ms)
      const cancel = (): void => clearTimeout(timer)
      if (disposed) {
        cancel()
      }
      else {
        cleanups.push(cancel)
      }
      return cancel
    },
    interval(run, ms) {
      const timer = setInterval(run, ms)
      const cancel = (): void => clearInterval(timer)
      if (disposed) {
        cancel()
      }
      else {
        cleanups.push(cancel)
      }
      return cancel
    },
    isDisposed: () => disposed,
    dispose() {
      if (disposed)
        return
      disposed = true
      for (const cleanup of cleanups.splice(0).reverse())
        cleanup()
    },
  }
}

/** cordis 的 effect 把 Fiber 绑进 `this`，客户端上下文挂在 `fiber.ctx` 上。 */
function effectContextOf(target: unknown): unknown {
  if (target === null || typeof target !== 'object')
    return target
  const candidate = (target as { ctx?: unknown }).ctx
  return candidate === undefined ? target : candidate
}

/**
 * 定义一组客户端注册：声明期只登记做什么，运行期创建控制器、执行 setup，
 * 并把 `controller.dispose()` 作为 effect 的 disposer 返回。
 */
export function defineRegister<Ctx = unknown>(setup: RegisterSetup<Ctx>): (this: unknown) => RegisterCleanup
export function defineRegister<Ctx = unknown>(ctx: Ctx, setup: RegisterSetup<Ctx>): (this: unknown) => RegisterCleanup
export function defineRegister(ctxOrSetup: unknown, maybeSetup?: unknown): (this: unknown) => RegisterCleanup {
  const boundCtx = typeof maybeSetup === 'function' ? ctxOrSetup : undefined
  const setup = (typeof maybeSetup === 'function' ? maybeSetup : ctxOrSetup) as RegisterSetup
  if (typeof setup !== 'function')
    throw new TypeError('defineRegister: 缺少注册回调，签名是 defineRegister([ctx,] setup)')
  // 实参的 ctx 是调用方泛型，实现体只按 unknown 转发（形参位置逆变，运行时无差异）。
  const run = setup as unknown as (controller: LifecycleController, ctx: unknown) => void | RegisterCleanup | readonly RegisterCleanup[]

  return function registerEffect(this: unknown): RegisterCleanup {
    const ctx = boundCtx ?? effectContextOf(this)
    const controller = createLifecycleController()
    try {
      const cleanup = run(controller, ctx)
      if (typeof cleanup === 'function') {
        controller.add(cleanup)
      }
      else if (Array.isArray(cleanup)) {
        for (const fn of cleanup) controller.add(fn)
      }
    }
    catch (error) {
      controller.dispose()
      throw error
    }
    return () => controller.dispose()
  }
}

// --- 本地化 ---

/** 双语词典声明：键集合以 `zh` 为权威。 */
export interface LocaleDicts<D extends Record<string, string> = Record<string, string>> {
  zh: D
  en: Record<keyof D & string, string>
}

/** 安装所需的最小上下文面。 */
export interface LocaleHost {
  locale: {
    bind: (namespace: string) => Translate
    getLocale: () => { active: string }
    register: (namespace: string, locale: string, dict: Record<string, string>) => () => void
    subscribe: (listener: () => void) => () => void
  }
}

/** `defineLocale` 的返回值：声明期即可拿到的全部消费面。 */
export interface LocaleDefinition<NS extends string = string, K extends string = string> {
  NS: NS
  text: Translate<K>
  activeLocale: () => string
  isEnglishLocale: () => boolean
  useLocale: () => string
  registerLocale: (this: unknown, ctx?: LocaleHost) => () => void
}

/** 非 React 同步取文案。 */
export type Translate<K extends string = string> = (key: K, params?: Record<string, unknown>) => string

const localeBridge = defineStore({ state: () => ({ active: FALLBACK_LOCALE }) })

/** 当前活跃语言 id（`ctx.locale` 快照的同步镜像，由 `registerLocale` 推进）。 */
export function activeLocale(): string {
  return localeBridge.$state.active
}

/** 当前是否英文界面。 */
export function isEnglishLocale(): boolean {
  return activeLocale().toLowerCase().startsWith('en')
}

/** React 组件订阅活跃语言（切换即重渲染）。 */
export function useLocale(): string {
  return useStore(localeBridge).active
}

/** 按 `{name}` 占位符插值；缺值的占位符原样保留。 */
function interpolate(template: string, params?: Record<string, unknown>): string {
  if (params === undefined)
    return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

/**
 * 声明一个插件的本地化契约。
 *
 * 独立仓库里 `dsh-tauri/client` 由宿主注入，垫片按 1.0.0 的实际契约重实现：
 * 未安装时读本地词典（测试走这条），安装后走运行时翻译。
 */
export function defineLocale<const NS extends string, const D extends Record<string, string>>(
  namespace: NS,
  dicts: LocaleDicts<D>,
): LocaleDefinition<NS, keyof D & string> {
  type K = keyof D & string

  const zh: Record<string, string> = dicts.zh
  const en: Record<string, string> = dicts.en
  let live: Translate | undefined
  let installations = 0

  function text(key: K, params?: Record<string, unknown>): string {
    const translate = live
    if (translate !== undefined)
      return translate(key, params)
    const template = (activeLocale() === 'en' ? en[key] : zh[key]) ?? en[key] ?? key
    return interpolate(template, params)
  }

  function registerLocale(this: unknown, ctx?: LocaleHost): () => void {
    const host = ctx ?? (effectContextOf(this) as LocaleHost | undefined)
    const locale = host?.locale
    if (locale === undefined)
      throw new TypeError('defineLocale: 缺少客户端上下文（用 ctx.effect(registerLocale, LABEL) 或 registerLocale(ctx)）')

    const bound = locale.bind?.(namespace)
    if (bound !== undefined)
      live = bound
    installations += 1

    const sync = (): void => {
      const active = locale.getLocale().active
      if (localeBridge.$state.active !== active)
        localeBridge.$state.active = active
    }
    const unregisterZh = locale.register(namespace, 'zh', zh)
    const unregisterEn = locale.register(namespace, 'en', en)
    sync()
    const unsubscribe = locale.subscribe(sync)

    let disposed = false
    return () => {
      if (disposed)
        return
      disposed = true
      unsubscribe()
      unregisterZh()
      unregisterEn()
      installations -= 1
      if (installations === 0 && live === bound)
        live = undefined
    }
  }

  return { NS: namespace, text, activeLocale, isEnglishLocale, useLocale, registerLocale }
}

// --- 桥接服务（垫片里只保留形状） ---

/** Tauri 命令调用：只有桌面运行时可用。 */
export function invoke<T = unknown>(command: string, _args?: Record<string, unknown>): Promise<T> {
  return Promise.reject(new Error(`dsh-tauri/client 垫片不提供 invoke：${command}`))
}

/** 监听父窗口消息：垫片里是空登记。 */
export function listenParent<T>(_handler: (payload: T) => void, _event?: string): RegisterCleanup {
  return () => {}
}

/** React 形态的 `listenParent`：垫片里什么都不挂。 */
export function useListenParent<T>(_handler: (payload: T) => void, _event?: string): void {}
