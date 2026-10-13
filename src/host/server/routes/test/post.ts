import type { RouteHandler } from '../../../routes/index'
import type { PostTestResult } from '../index.types'
import { notifier } from '../../../service/notifier'

/** `POST /test`：用当前已落盘的配置真发一条推送，结果原样回包。 */
export const testPost: RouteHandler = async () => {
  return [200, await notifier.test() satisfies PostTestResult]
}
