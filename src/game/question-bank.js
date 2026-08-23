import { CONFIG } from '../config.js'
import { randomCode } from '../util/random.js'

// 問題セット（出題者の端末にのみ保存。P2P には答え・メモを一切流さない）。
// ブラウザ保存は消えることがある前提で、正本はエクスポートしたファイルとする。
//
// 1問のデータ: { id, type, q, a, choices, memo, history: [{ at, winner, wrongs }] }
//   type   : 'buzzer'=早押し（答えは自由記述・出題者が目視判定）
//            'ox'=○×（a は 'o' か 'x'）
//            'choice4'=4択（choices に選択肢4つ、a は '1'〜'4'）
//   history には出題のたびに
//   { at: 出題日時(epoch ms), winner: 正解者名 | null, wrongs: 誤答者名の配列 } が積まれる

const BANK_KEY = 'hayabuzz.questionBank'
const EXPORTED_KEY = 'hayabuzz.questionBank.exportedAt'
const MAX_ITEMS = 2000

export const QUESTION_TYPES = ['buzzer', 'ox', 'choice4']
export const TYPE_LABEL = { buzzer: '早押し', ox: '○×', choice4: '4択' }

const isItem = (v) =>
  typeof v === 'object' &&
  v !== null &&
  typeof v.id === 'string' &&
  typeof v.q === 'string' &&
  typeof v.a === 'string' &&
  typeof v.memo === 'string' &&
  Array.isArray(v.history)

function sanitizeItem(raw) {
  // type を持たない旧データは早押し問題として扱う
  const type = QUESTION_TYPES.includes(raw.type) ? raw.type : 'buzzer'
  const choices = Array.isArray(raw.choices)
    ? raw.choices.filter((c) => typeof c === 'string').map((c) => c.slice(0, 100)).slice(0, 4)
    : []
  return {
    id: raw.id.slice(0, 16),
    type,
    q: raw.q.slice(0, CONFIG.questionMaxLen),
    a: raw.a.slice(0, 200),
    choices: type === 'choice4' ? choices : [],
    memo: raw.memo.slice(0, 500),
    history: raw.history
      .filter((h) => typeof h === 'object' && h !== null && typeof h.at === 'number')
      .map((h) => ({
        at: h.at,
        winner: typeof h.winner === 'string' ? h.winner.slice(0, 30) : null,
        wrongs: Array.isArray(h.wrongs)
          ? h.wrongs.filter((w) => typeof w === 'string').map((w) => w.slice(0, 30)).slice(0, 50)
          : [],
      })),
  }
}

export function loadBank() {
  try {
    const parsed = JSON.parse(localStorage.getItem(BANK_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isItem).map(sanitizeItem)
  } catch {
    return []
  }
}

export function saveBank(items) {
  try {
    localStorage.setItem(BANK_KEY, JSON.stringify(items))
  } catch {
    // 容量超過等。エクスポートを正本とする運用のため致命的にはしない
  }
}

export function addQuestion(items, { type = 'buzzer', q, a = '', choices = [], memo = '' }) {
  if (items.length >= MAX_ITEMS) return null
  const item = sanitizeItem({ id: randomCode(8), type, q, a, choices, memo, history: [] })
  if (item.q.trim() === '') return null
  items.push(item)
  return item
}

// 貼り付け取り込み（1行1問・タブ区切り）。形式は列の並びで判別する:
//   早押し: 問題 / 答え / メモ
//   ○×  : 問題 / ○ か × / メモ
//   4択  : 問題 / 選択肢1 / 選択肢2 / 選択肢3 / 選択肢4 / 正解番号 / メモ
export function importTsv(items, text) {
  let count = 0
  for (const line of text.split('\n')) {
    const cells = line.split('\t').map((c) => c.trim())
    const q = cells[0] ?? ''
    if (q === '') continue
    let spec
    if (cells.length >= 6 && /^[1-4]$/.test(cells[5])) {
      spec = { type: 'choice4', q, choices: cells.slice(1, 5), a: cells[5], memo: cells[6] ?? '' }
    } else if (['○', 'o', 'O', '×', 'x', 'X'].includes(cells[1] ?? '')) {
      const isCircle = ['○', 'o', 'O'].includes(cells[1])
      spec = { type: 'ox', q, a: isCircle ? 'o' : 'x', memo: cells[2] ?? '' }
    } else {
      spec = { type: 'buzzer', q, a: cells[1] ?? '', memo: cells[2] ?? '' }
    }
    if (addQuestion(items, spec) !== null) count += 1
  }
  return count
}

export function removeQuestion(items, id) {
  const index = items.findIndex((item) => item.id === id)
  if (index >= 0) items.splice(index, 1)
}

// 出題時に履歴を積む（結果は判定時に recordOutcome で書き込む）
export function markAsked(items, id, at) {
  const item = items.find((i) => i.id === id)
  if (item) item.history.push({ at, winner: null, wrongs: [] })
}

export function recordOutcome(items, id, winner, wrongs = []) {
  const item = items.find((i) => i.id === id)
  if (!item) return
  if (item.history.length === 0) item.history.push({ at: Date.now(), winner, wrongs })
  else Object.assign(item.history[item.history.length - 1], { winner, wrongs })
}

// ---- ファイルへのエクスポート / 復元 ----

export function exportPayload(items) {
  return JSON.stringify({ app: 'hayabuzz', version: 1, exportedAt: new Date().toISOString(), questions: items }, null, 1)
}

// 検証に通れば questions を返し、通らなければ null（呼び出し側で置き換える）
export function parseImport(text) {
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || parsed.app !== 'hayabuzz' || !Array.isArray(parsed.questions)) {
      return null
    }
    return parsed.questions.filter(isItem).map(sanitizeItem).slice(0, MAX_ITEMS)
  } catch {
    return null
  }
}

export function setExportedAt(at) {
  try {
    localStorage.setItem(EXPORTED_KEY, String(at))
  } catch {
    // 保存できなくても支障なし
  }
}

export function getExportedAt() {
  const value = Number(localStorage.getItem(EXPORTED_KEY))
  return Number.isFinite(value) && value > 0 ? value : null
}
