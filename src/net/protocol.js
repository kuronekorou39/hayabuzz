import { CONFIG } from '../config.js'
import { PHASE } from '../game/phases.js'

export const PROTO_VERSION = 1

export const MSG = {
  // player → host
  HELLO: 'hello', // 参加/再参加要求
  PONG: 'pong', // ping への応答
  BUZZ: 'buzz', // 早押し
  // host → player
  WELCOME: 'welcome', // 参加受理
  REJECTED: 'rejected', // 参加拒否
  PING: 'ping', // 時刻同期
  STATE: 'state', // 状態スナップショット（全量配信）
}

// ---- フィールド検証ヘルパ ----
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isBool = (v) => typeof v === 'boolean'
const str = (max) => (v) => typeof v === 'string' && v.length >= 1 && v.length <= max
const str0 = (max) => (v) => typeof v === 'string' && v.length <= max
const oneOf = (values) => (v) => values.includes(v)
const nullable = (check) => (v) => v === null || check(v)
const arrayOf = (check, maxLen = 100) => (v) =>
  Array.isArray(v) && v.length <= maxLen && v.every(check)

function matchesShape(obj, shape) {
  if (typeof obj !== 'object' || obj === null) return false
  return Object.entries(shape).every(([key, check]) => check(obj[key]))
}

const id = str(32) // sessionId / playerId
const nick = str(CONFIG.nickMaxLen)
const shapeOf = (shape) => (v) => matchesShape(v, shape)

// メッセージ型ごとの必須フィールドと型。ここに合わないものは受信時に破棄する。
const SCHEMAS = {
  [MSG.HELLO]: { proto: isNum, sessionId: id, nick },
  [MSG.PONG]: { seq: isNum, t: isNum },
  [MSG.BUZZ]: { qid: isNum, t: isNum },
  [MSG.WELCOME]: { playerId: id, resumed: isBool },
  [MSG.REJECTED]: { reason: str(100) },
  [MSG.PING]: { seq: isNum },
  [MSG.STATE]: {
    phase: oneOf(Object.values(PHASE)),
    qid: isNum,
    questionText: str0(CONFIG.questionMaxLen),
    armedAt: nullable(isNum), // 早押し受付開始の host 時刻（フライング判定の基準）
    players: arrayOf(shapeOf({ playerId: id, nick, score: isNum, connected: isBool, handicapMs: isNum })),
    order: arrayOf(shapeOf({ playerId: id, deltaMs: isNum })),
    activePlayerId: nullable(id), // 回答権を持つ player
    excluded: arrayOf(id),
    result: nullable(shapeOf({ playerId: nullable(id), correct: isBool })),
    rules: shapeOf({ pressSound: oneOf(['winner', 'all']) }),
  },
}

// 受信メッセージのスキーマ検証。通れば true、想定外の型・値なら false（破棄する）。
export function validateMessage(msg) {
  if (typeof msg !== 'object' || msg === null) return false
  const shape = SCHEMAS[msg.type]
  return shape !== undefined && matchesShape(msg, shape)
}
