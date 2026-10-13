import type { HostContext } from 'dsh-tauri'
import type { RouteRequest } from '../routes/index'
import { jsonRoute } from '../routes/index'
import { deliveryPost } from './routes/delivery/post'
import { settingsGet } from './routes/settings/get'
import { settingsPost } from './routes/settings/post'
import { testPost } from './routes/test/post'
import { turnEndGet } from './routes/turn-end/get'

/** 路由前缀：客户端 `apis/index.ts` 与这里的字面量必须逐字一致。 */
const BASE = '/api/tauri/notify-webhook'

/**
 * 装配四条宿主路由：
 *
 * - `GET|POST /api/tauri/notify-webhook/settings`
 * - `POST /api/tauri/notify-webhook/test`
 * - `GET /api/tauri/notify-webhook/turn-end`
 * - `POST /api/tauri/notify-webhook/delivery`
 *
 * 设置路由读写在同一条路径上：桌面壳的 webServer 按路径建表，同一路径注册两次
 * 会抛 duplicate route，因此 GET 与 POST 合成一条 handler 按方法分流。
 * 卸载时逐条收回注册句柄。
 */
export function server(ctx: HostContext): () => void {
  // 宿主连接闸门：`guard` 是 h3 中间件，挂不到裸 (req, res) 上，这里按同一契约接线。
  const reject = (req: RouteRequest): number | undefined => ctx.connection?.requestRejection?.(req)

  const disposers = [
    ctx.webServer.register(jsonRoute(`${BASE}/settings`, (body, req) => {
      return req.method === 'POST' ? settingsPost(body, req) : settingsGet(body, req)
    }, { methods: ['GET', 'POST'], reject })),
    ctx.webServer.register(jsonRoute(`${BASE}/test`, testPost, { methods: ['POST'], reject })),
    ctx.webServer.register(jsonRoute(`${BASE}/turn-end`, turnEndGet, { methods: ['GET'], reject })),
    ctx.webServer.register(jsonRoute(`${BASE}/delivery`, deliveryPost, { methods: ['POST'], reject })),
  ]

  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function')
        dispose()
    }
  }
}
