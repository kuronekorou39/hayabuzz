import { bgSprite, spriteFormatReady } from './sprites.js'

// 背景画像（夜景8パターンからページ読み込みごとにランダムで1枚）。
// 可読性を保つため、上に濃い黒のベールを重ねて表示する。
// 再生成: node scripts/extract-backgrounds.mjs

const PATTERN_COUNT = 8
let chosen = 1 + Math.floor(Math.random() * PATTERN_COUNT)

// 現在と別のパターンを引き直して適用する（設定の「シャッフル」から呼ぶ）
export function shuffleBackground() {
  let next
  do {
    next = 1 + Math.floor(Math.random() * PATTERN_COUNT)
  } while (next === chosen)
  chosen = next
  applyBackground(true)
}

export function applyBackground(enabled) {
  if (!enabled) {
    document.body.style.backgroundImage = ''
    return
  }
  document.body.style.backgroundSize = 'cover'
  document.body.style.backgroundPosition = 'center'
  spriteFormatReady.then(() => {
    document.body.style.backgroundImage =
      `linear-gradient(rgba(16, 20, 26, 0.8), rgba(16, 20, 26, 0.88)), url("${bgSprite(chosen)}")`
  })
}
