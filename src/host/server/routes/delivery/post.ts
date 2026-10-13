import type { RouteHandler } from '../../../routes/index'
import type { DeliveryOutcome } from '../../../types/index'
import { notifier } from '../../../service/notifier'

interface PostDeliveryBody {
  sessionId?: string
  title?: string
  trigger?: string
}

/** `POST /delivery`：客户端观察到回合结束后来敲一记，实际送信由 notifier 决定。 */
export const deliveryPost: RouteHandler = async (body) => {
  const payload = body as PostDeliveryBody
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  if (sessionId.length === 0)
    return [200, { ok: false, error: 'NOTIFY_INVALID: sessionId' } satisfies DeliveryOutcome]
  if (payload.trigger !== 'completed' && payload.trigger !== 'abnormal')
    return [200, { ok: false, error: 'NOTIFY_INVALID: trigger' } satisfies DeliveryOutcome]
  return [200, await notifier.deliver(sessionId, typeof payload.title === 'string' ? payload.title : '', payload.trigger) satisfies DeliveryOutcome]
}
