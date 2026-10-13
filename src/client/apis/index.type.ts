export interface GetApiTauriNotifyWebhookSettingsResponse { settings?: undefined | { channel: string, notifyOnComplete: false | true, notifyOnAbnormal: false | true, email: { host: string, port: number, security: string, username: string, password: string, from: string, to: string }, pushplus: { token: string } }, error?: undefined | string }
export interface PostApiTauriNotifyWebhookSettingsResponse { settings?: undefined | { channel: string, notifyOnComplete: false | true, notifyOnAbnormal: false | true, email: { host: string, port: number, security: string, username: string, password: string, from: string, to: string }, pushplus: { token: string } }, error?: undefined | string }
export interface PostApiTauriNotifyWebhookTestResponse { ok?: undefined | false | true, error?: undefined | string }
export interface GetApiTauriNotifyWebhookTurnEndResponse { reason?: undefined | string, turn?: undefined | number }
export type GetApiTauriNotifyWebhookTurnEndQuerySessionId = undefined | string
export interface PostApiTauriNotifyWebhookDeliveryResponse { ok: false | true, error?: undefined | string }

export interface PostApiTauriNotifyWebhookSettingsBody {
  settings?: undefined | { channel: string, notifyOnComplete: false | true, notifyOnAbnormal: false | true, email: { host: string, port: number, security: string, username: string, password: string, from: string, to: string }, pushplus: { token: string } }
}
export interface PostApiTauriNotifyWebhookDeliveryBody {
  sessionId?: undefined | string
  title?: undefined | string
  trigger?: undefined | string
}
export interface GetApiTauriNotifyWebhookTurnEndQuery {
  sessionId?: GetApiTauriNotifyWebhookTurnEndQuerySessionId
}
