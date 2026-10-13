import { IncomingMessage, ServerResponse } from "node:http";

//#region compat/dsh-tauri.d.ts

/** 宿主路由表条目。 */
interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/**
 * 宿主上下文里本插件用到的面。
 *
 * `connection` 与 `logger` 都是可选：独立安装时宿主版本可能还没提供对应服务，
 * 缺失只表示「没有额外的拒绝判据」，不表示可以跳过回环闸门。
 */
interface HostContext {
  on: (event: string, listener: (...args: never[]) => void) => unknown;
  effect: (run: (this: unknown) => unknown, label?: string) => unknown;
  webServer: {
    register: (route: WebRoute) => unknown;
  };
  connection?: {
    requestRejection?: ((req: IncomingMessage) => number | undefined) | undefined;
  } | undefined;
  logger?: {
    error: (...args: unknown[]) => void;
  } | undefined;
}
//#endregion
//#region src/host/apply.d.ts
declare function apply(ctx: HostContext): void;
//#endregion
//#region src/index.d.ts
declare const name = "dsh-tauri-notify-webhook";
/** 宿主服务依赖：`webServer`（注册路由）与 `connection`（路由鉴权闸门，注册期必需）。 */
declare const inject: string[];
//#endregion
export { apply, inject, name };