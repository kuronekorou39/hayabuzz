// 端末ローカルの表示・効果音設定（個人情報は含まない）
const KEY = 'hayabuzz.prefs'
const DEFAULTS = { buttonStyle: 'classic', sound: true, volume: 0.9 }

export function loadPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    const merged = { ...DEFAULTS, ...(typeof stored === 'object' && stored !== null ? stored : {}) }
    // 旧バージョンの「効果音 OFF」チェックは音量0として引き継ぐ
    if (stored?.sound === false && stored?.volume === undefined) {
      merged.volume = 0
      merged.sound = true
    }
    return merged
  } catch {
    return { ...DEFAULTS }
  }
}

export function savePrefs(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // プライベートブラウジング等で保存できない場合は無視（その場限りの設定になる）
  }
}
