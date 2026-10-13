import type { ClientContext } from './dsh-tauri-client'

export type { ClientContext }

/** 一次性清理句柄。 */
export type RegisterCleanup = () => void

/**
 * 注册回调：只在 effect 运行时被调用一次。
 *
 * 第三个参数（真实实现的 adapter）在本插件里用不到，垫片直接省掉：
 * setup 只声明两个形参，多传一个参数并不影响调用。
 */
export type RegisterSetup<Ctx = unknown> = (
  controller: LifecycleController,
  ctx: Ctx,
) => void | RegisterCleanup | readonly RegisterCleanup[]

/** 客户端生命周期控制器：与真实实现的同名方法一一对应。 */
export interface LifecycleController {
  /** 登记一次性清理句柄；卸载时按登记顺序逆序执行。 */
  add: (cleanup: RegisterCleanup) => void
  /** 登记一个定时器，返回"立即取消"句柄。 */
  timeout: (run: () => void, ms: number) => RegisterCleanup
  /** 登记一个周期定时器，返回"立即取消"句柄。 */
  interval: (run: () => void, ms: number) => RegisterCleanup
  /** 是否已卸载（卸载后一切异步回包都必须丢弃）。 */
  isDisposed: () => boolean
  /** 卸载并回收全部登记资源。 */
  dispose: () => void
}
