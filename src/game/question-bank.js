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

// 同じ形式・同じ問題文はひとつだけ持つ（取り込みを繰り返しても増殖しない）
function findDuplicate(items, type, q) {
  return items.find((item) => item.type === type && item.q === q) ?? null
}

export function addQuestion(items, { type = 'buzzer', q, a = '', choices = [], memo = '' }) {
  if (items.length >= MAX_ITEMS) return null
  const item = sanitizeItem({ id: randomCode(8), type, q: q.trim(), a, choices, memo, history: [] })
  if (item.q === '') return null
  if (findDuplicate(items, item.type, item.q) !== null) return null
  items.push(item)
  return item
}

// 貼り付け取り込み（1行1問・タブ区切り）。列の並びは形式ごとに決まっている:
//   早押し: 問題 / 答え / メモ
//   ○×  : 問題 / ○ か × / メモ
//   4択  : 問題 / 選択肢1 / 選択肢2 / 選択肢3 / 選択肢4 / 正解番号 / メモ
// 形式は呼び出し側が指定する（中身から推測すると、答えが「○」の早押し問題を
// ○×として取り込んでしまうなどの誤判定が避けられないため）。
// 戻り値は { added: 追加できた数, skipped: 重複などで飛ばした数 }
export function importTsv(items, text, type = 'buzzer') {
  let added = 0
  let skipped = 0
  for (const line of text.split('\n')) {
    const cells = line.split('\t').map((c) => c.trim())
    const q = cells[0] ?? ''
    if (q === '') continue
    let spec
    if (type === 'choice4') {
      const correct = cells[5] ?? ''
      spec = {
        type,
        q,
        choices: cells.slice(1, 5),
        a: /^[1-4]$/.test(correct) ? correct : '', // 正解番号が無ければ「未定」として取り込む
        memo: cells[6] ?? '',
      }
    } else if (type === 'ox') {
      const value = cells[1] ?? ''
      const answer = ['○', '〇', 'o', 'O'].includes(value) ? 'o' : ['×', 'x', 'X'].includes(value) ? 'x' : ''
      spec = { type, q, a: answer, memo: cells[2] ?? '' }
    } else {
      spec = { type: 'buzzer', q, a: cells[1] ?? '', memo: cells[2] ?? '' }
    }
    if (addQuestion(items, spec) !== null) added += 1
    else skipped += 1
  }
  return { added, skipped }
}

// 既存の問題を書き換える（出題履歴は保つ）。問題文が空、または他の問題と
// 同じ形式・同じ問題文になる場合は変更しない
export function updateQuestion(items, id, { type = 'buzzer', q, a = '', choices = [], memo = '' }) {
  const item = items.find((i) => i.id === id)
  if (item === undefined) return null
  const updated = sanitizeItem({ id: item.id, type, q: q.trim(), a, choices, memo, history: item.history })
  if (updated.q === '') return null
  if (items.some((other) => other.id !== id && other.type === updated.type && other.q === updated.q)) return null
  Object.assign(item, updated)
  return item
}

export function removeQuestion(items, id) {
  const index = items.findIndex((item) => item.id === id)
  if (index >= 0) items.splice(index, 1)
}

// ○× の答えは内部では 'o'/'x' なので、画面と同じ記号でも探せるようにする
const OX_SYMBOL = { o: '○', x: '×' }

function searchTarget(item) {
  const answer = item.type === 'ox' ? OX_SYMBOL[item.a] ?? '' : item.a
  return [item.q, answer, item.memo, ...item.choices].join('\n').toLowerCase()
}

// 一覧の絞り込み。type が空なら全形式、text が空なら全件。
// 文字列は問題文・答え・メモ・選択肢への部分一致で見る
export function filterQuestions(items, { type = '', text = '' } = {}) {
  const needle = text.trim().toLowerCase()
  return items.filter((item) => {
    if (type !== '' && item.type !== type) return false
    return needle === '' || searchTarget(item).includes(needle)
  })
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

// 読み込んだ問題を取り込む。replace=true なら今の問題集を空にしてから入れ替える。
// どちらの場合も同じ問題（形式+問題文が同じ）は取り込まない
export function applyImport(items, incoming, { replace = false } = {}) {
  if (replace) items.length = 0
  let added = 0
  let skipped = 0
  for (const question of incoming) {
    if (items.length >= MAX_ITEMS || findDuplicate(items, question.type, question.q) !== null) {
      skipped += 1
      continue
    }
    items.push(question)
    added += 1
  }
  return { added, skipped }
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
