// 接続の診断ログ。トラッカー・WebRTC の経過と例外を時系列で記録し、
// 「接続できませんでした」画面や設定の「接続診断」から確認できるようにする。
// （どの端末のどの段階で止まったかを、実機の画面だけで特定するため）

const entries = []
const startedAt = Date.now()
const MAX_ENTRIES = 150

export function diagLog(tag, detail = '') {
  entries.push({ at: Date.now() - startedAt, tag, detail: String(detail).slice(0, 160) })
  if (entries.length > MAX_ENTRIES) entries.shift()
}

export function diagText(maxLines = 25) {
  if (entries.length === 0) return '（記録なし）'
  return entries
    .slice(-maxLines)
    .map((e) => `+${(e.at / 1000).toFixed(1)}s ${e.tag}${e.detail !== '' ? ` ${e.detail}` : ''}`)
    .join('\n')
}
