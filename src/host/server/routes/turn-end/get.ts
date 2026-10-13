import type { RouteHandler } from '../../../routes/index'
import type { GetTurnEndResult } from '../index.types'
import { turnEndFacts } from '../../../config/runtime'

/**
 * `GET /turn-end?sessionId=…`：回答「这个会话的回合为什么结束」。
 *
 * 查不到就返回空对象（200）而不是 404：调用方只关心「是不是异常停止」，
 * 未知一律按「不是」处理，没必要区分「没记录」与「会话不存在」。
 */
export const turnEndGet: RouteHandler = async (_body, req) => {
  const sessionId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('sessionId') ?? ''
  if (sessionId.length === 0)
    return [200, {} satisfies GetTurnEndResult]
  const fact = turnEndFacts.get(sessionId)
  return [200, (fact === undefined ? {} : { reason: fact.reason, turn: fact.turn }) satisfies GetTurnEndResult]
}
