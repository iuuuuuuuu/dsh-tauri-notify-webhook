import type { RouteHandler } from '../../../routes/index'
import type { GetSettingsResult } from '../index.types'
import { settings } from '../../../service/settings'
import { deliveryErrorOf } from '../../../utils/error'

/** `GET /settings`：读回宿主当前生效的设置。 */
export const settingsGet: RouteHandler = async () => {
  try {
    return [200, { settings: await settings.load() } satisfies GetSettingsResult]
  }
  catch (error) {
    return [200, { error: deliveryErrorOf(error) } satisfies GetSettingsResult]
  }
}
