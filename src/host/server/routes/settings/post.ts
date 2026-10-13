import type { RouteHandler } from '../../../routes/index'
import type { PostSettingsBody, PostSettingsResult } from '../index.types'
import { settings } from '../../../service/settings'
import { deliveryErrorOf } from '../../../utils/error'

/** `POST /settings`：整份设置归一化后落盘，回包是归一化结果。 */
export const settingsPost: RouteHandler = async (body) => {
  const payload = body as PostSettingsBody
  if (payload.settings === undefined)
    return [200, { error: 'NOTIFY_INVALID: settings' } satisfies PostSettingsResult]
  try {
    return [200, { settings: await settings.save(payload.settings) } satisfies PostSettingsResult]
  }
  catch (error) {
    return [200, { error: deliveryErrorOf(error) } satisfies PostSettingsResult]
  }
}
