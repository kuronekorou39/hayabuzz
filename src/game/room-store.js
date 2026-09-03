import { CONFIG } from '../config.js'

// 出題者の部屋（ルームコードと進行状態）をこの端末に保存し、リロードやタブを閉じた後でも
// 同じ部屋に復帰できるようにする。状態はすべて host が持っているため、これがないと
// 出題者が画面を更新しただけで部屋が作り直しになってしまう。
// 保存先は localStorage（この端末のみ。回答者の端末には何も残らない）
const KEY = 'hayabuzz.hostRoom'
const FORMAT = 1 // 保存形式の版。変えたら古い保存は復帰対象にしない
const ROOM_CODE = /^[A-Z0-9]{4,32}$/

// 復帰できる部屋があればその保存内容、なければ null。
// 古すぎるもの（CONFIG.hostRoomTtlMs）と壊れたものは無いものとして扱う
export function loadHostRoom(now = Date.now()) {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (typeof stored !== 'object' || stored === null || stored.format !== FORMAT) return null
    if (typeof stored.roomCode !== 'string' || !ROOM_CODE.test(stored.roomCode)) return null
    if (typeof stored.savedAt !== 'number' || now - stored.savedAt > CONFIG.hostRoomTtlMs) return null
    if (typeof stored.game !== 'object' || stored.game === null) return null
    return stored
  } catch {
    return null
  }
}

export function saveHostRoom(room) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ format: FORMAT, ...room }))
  } catch {
    // 容量超過・プライベートブラウジング等。復帰できなくなるだけで進行は続けられる
  }
}

export function clearHostRoom() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // 消せなくても期限切れで無視される
  }
}
