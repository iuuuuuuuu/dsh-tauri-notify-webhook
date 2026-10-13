import type { ComponentType } from 'react'

/**
 * compat/dsh-tauri-client —— `dsh-tauri/client` 的本地垫片入口。
 *
 * 常量与类型分文件是刻意的：测试里 `dsh-tauri/client` 会被 `vi.mock` 顶替，
 * 顶替模块（`src/client/test-utils/client-mock.ts`）需要拿到**真实实现**，
 * 因此从 `./dsh-tauri-client.impl` 直连——同一入口里写实现会被自己发起的 mock 递归命中。
 *
 * 这份垫片只服务于 typecheck 与测试：真实模块由桌面壳在运行时注入
 * （列在 `package.json` 的 `dsh.client.external` 里），不参与构建产物。
 */
export * from './dsh-tauri-client.impl'

/** 客户端上下文里本插件用到的面：槽位、本地化、会话服务与通用的服务读取。 */
export interface ClientContext {
  /** 声明式副作用：注册期不做事，运行期由框架调用 `run` 并托管返回的 disposer。 */
  effect: (run: (this: unknown) => unknown, label?: string) => unknown
  /** 读取宿主服务；服务不存在时返回 `undefined`（不是抛错）。 */
  get: (service: string) => unknown
  slots: {
    /** 订阅槽位；回放时会立即调用一次贡献回调。 */
    inject: (slot: string, contribute: () => unknown) => () => void
    /** 往槽位登记一个贡献。 */
    register: (options: Record<string, unknown>, component: ComponentType) => unknown
  }
  locale: Record<string, unknown>
  [key: string]: unknown
}
