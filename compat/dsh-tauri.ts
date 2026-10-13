import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * compat/dsh-tauri —— 宿主侧 `dsh-tauri` 的本地垫片。
 *
 * 独立仓库不能依赖桌面仓的源码，而 npm 上的 `dsh-tauri` 不带 `dist/index.d.ts`。
 * 这里按 1.0.0 的实际契约复刻本插件真正导入的成员：类型供 typecheck，实现供单测。
 * 真实模块由桌面壳在运行时注入（构建产物里 `dsh-tauri` 保持 external），
 * 这份文件不参与打包。
 */

/** 与运行时一致：`DSH_HOME` 环境变量优先，否则 `~/.dsh`。 */
export const DSH_HOME: string = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 编译期约束成员全为函数（散装状态留在模块作用域）；运行时原样返回。 */
export function defineService<T extends Record<string, (...args: never[]) => unknown>>(service: T): T {
  return service
}

/** rename 撞上 Windows 句柄占用时的重试上限与间隔（与运行时同值）。 */
const RENAME_MAX_RETRIES = 8
const RENAME_RETRY_DELAY_MS = 25

/** 原子写：同目录临时文件 + rename 覆盖，rename 撞 EPERM 时重试。 */
export async function writeAtomic(target: string, value: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, value, 'utf8')
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(tmp, target)
        return
      }
      catch (error) {
        const code = (error as { code?: string }).code
        if (code !== 'EPERM' || attempt >= RENAME_MAX_RETRIES)
          throw error
        await delay(RENAME_RETRY_DELAY_MS)
      }
    }
  }
  catch (error) {
    await unlink(tmp).catch(() => undefined)
    throw error
  }
}

/** 宿主每条路由收到的请求/响应对象（与 `@deepseek-ai/dsh-host-webserver` 的 `WebRoute` 同构）。 */
export type { IncomingMessage, ServerResponse }

/** 宿主路由表条目。 */
export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/**
 * 宿主上下文里本插件用到的面。
 *
 * `connection` 与 `logger` 都是可选：独立安装时宿主版本可能还没提供对应服务，
 * 缺失只表示「没有额外的拒绝判据」，不表示可以跳过回环闸门。
 */
export interface HostContext {
  on: (event: string, listener: (...args: never[]) => void) => unknown
  effect: (run: (this: unknown) => unknown, label?: string) => unknown
  webServer: { register: (route: WebRoute) => unknown }
  connection?: { requestRejection?: ((req: IncomingMessage) => number | undefined) | undefined } | undefined
  logger?: { error: (...args: unknown[]) => void } | undefined
}
