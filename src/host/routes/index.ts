import type { WebRoute } from 'dsh-tauri'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Buffer } from 'node:buffer'

/**
 * host/routes —— 自建的最小 JSON 路由层。
 *
 * 桌面壳的 webServer 只接受 `{ kind, path, handler(req, res) }`：路由的具体语义
 * （方法白名单、请求体解析、错误码）由插件自己定。这里只保留本插件需要的部分：
 * 精确路径、显式方法集合、JSON 请求体、统一 `[状态码, 载荷]` 回包。
 *
 * 安全闸门与宿主 `guard` 同口径（本机地址 + 同源 + 改写类方法），因为
 * `dsh-tauri` 导出的 `guard` 是 h3 形状的中间件，挂不到裸 `(req, res)` 上。
 */

/** 请求体上限：设置面板传的是配置对象，64 KiB 已经远超实际用量。 */
const MAX_ROUTE_BODY_BYTES = 64 * 1024

/** 默认处理超时：与投递超时（15s）留足余量；超时不代表操作没生效。 */
const DEFAULT_TIMEOUT_MS = 30_000

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** 改写类方法：与宿主 guard 同一张表，命中就要求本机来源 + 同源。 */
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** 宿主每条路由收到的请求/响应对象。 */
export type RouteRequest = IncomingMessage
export type RouteResponse = ServerResponse

/** 处理结果：HTTP 状态码 + JSON 载荷。 */
export type RouteHandler = (body: Record<string, unknown>, req: RouteRequest) => Promise<[number, unknown]> | [number, unknown]

/** 注册选项：`methods` 是「这条路允许哪些方法」，空数组表示不限制。 */
export interface JsonRouteOptions {
  methods?: readonly string[]
  timeoutMs?: number
  /**
   * 宿主连接闸门（同 `dsh-tauri` 的 `guard`）：返回 401/403 时直接拦截，
   * 其余返回值一律放行。判据由宿主 `connection` 服务给出，插件只负责接线。
   */
  reject?: (req: RouteRequest) => number | undefined
}

/**
 * 请求体只在这里解析成 JSON：设置路由是本插件唯一收体的地方，
 * 其它路由用不上，也就不读流。
 */
function readBody(req: RouteRequest, limit: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled)
        return
      settled = true
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > limit) {
        fail(new TypeError('body too large'))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', fail)
    req.on('end', () => {
      if (settled)
        return
      settled = true
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text.length === 0) {
        resolve({})
        return
      }
      try {
        const parsed: unknown = JSON.parse(text)
        resolve(parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {})
      }
      catch {
        reject(new SyntaxError('request body is not valid JSON'))
      }
    })
  })
}

/**
 * 请求是否真的带了体：`content-length: 0` 的 POST（例如无参数的「测试推送」）
 * 既不需要 content-type，也不该去读流——读了只会把连接挂住。
 */
function hasBody(req: RouteRequest): boolean {
  if (req.headers['transfer-encoding'] !== undefined)
    return true
  const length = Number(req.headers['content-length'] ?? '0')
  return Number.isFinite(length) && length > 0
}

/** 请求是否来自本机地址（同源校验的前置条件）。 */
function isLoopback(req: RouteRequest): boolean {
  return LOOPBACK_IPS.has(req.socket.remoteAddress ?? '')
}

/**
 * 改写类请求额外要求同源：桌面壳里同源就是「本机的同一个 host:port」，
 * 跨源页面即使能打到本机也不该改配置。
 */
function isSameOrigin(req: RouteRequest): boolean {
  const origin = req.headers.origin
  if (origin === undefined)
    return true
  const host = req.headers.host
  if (host === undefined || host.length === 0)
    return false
  try {
    return new URL(origin).origin === new URL(`http://${host}`).origin
  }
  catch {
    return false
  }
}

/**
 * 把处理函数包成宿主可注册的路由。
 *
 * 状态码约定：`RouteHandler` 返回的一定是「已经处理过」的载荷（含业务错误），
 * 路由层自己只负责协议级失败（405 / 413 / 415 / 403 / 504 / 500）。
 */
export function jsonRoute(path: string, handler: RouteHandler, options: JsonRouteOptions = {}): WebRoute {
  const methods = options.methods ?? []
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { reject } = options

  return {
    kind: 'exact',
    path,
    handler: async (req: RouteRequest, res: RouteResponse): Promise<void> => {
      let responded = false
      let timer: ReturnType<typeof setTimeout> | undefined

      const send = (status: number, payload: unknown): void => {
        if (responded)
          return
        responded = true
        clearTimeout(timer)
        const text = JSON.stringify(payload)
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        })
        res.end(req.method === 'HEAD' ? undefined : text)
      }

      timer = setTimeout(send, timeoutMs, 504, { error: 'request timed out' })

      try {
        const method = (req.method ?? 'GET').toUpperCase()
        // HEAD 与 GET 同表：Node 在发完头之后会自动丢掉响应体，这里不需特殊处理。
        const effective = method === 'HEAD' ? 'GET' : method
        if (methods.length > 0 && !methods.includes(effective)) {
          // HEAD 与 GET 同表，405 的 allow 也要如实列出它。
          const allow = methods.includes('GET') && !methods.includes('HEAD') ? [...methods, 'HEAD'] : methods
          res.setHeader('allow', allow.join(', '))
          send(405, { error: 'method not allowed' })
          return
        }
        if (reject !== undefined) {
          const status = reject(req)
          if (status === 401) {
            send(401, { error: 'unauthorized' })
            return
          }
          if (status === 403) {
            send(403, { error: 'forbidden' })
            return
          }
        }
        if (MUTATION_METHODS.has(effective)) {
          if (!isLoopback(req)) {
            send(403, { error: 'Change operation is limited to local machine (127.0.0.1) calls only' })
            return
          }
          if (!isSameOrigin(req)) {
            send(403, { error: 'cross-origin-request' })
            return
          }
        }

        let body: Record<string, unknown> = {}
        if (MUTATION_METHODS.has(effective) && hasBody(req)) {
          const contentType = req.headers['content-type'] ?? ''
          if (!contentType.includes('application/json')) {
            send(415, { error: 'content-type must be application/json' })
            return
          }
          body = await readBody(req, MAX_ROUTE_BODY_BYTES)
        }

        const [status, payload] = await handler(body, req)
        send(status, payload)
      }
      catch (error) {
        send(500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}
