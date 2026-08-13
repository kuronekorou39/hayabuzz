// 端末ローカルの表示・効果音設定（個人情報は含まない）
const KEY = 'hayabuzz.prefs'
const DEFAULTS = { buttonStyle: 'classic', sound: true }

export function loadPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { ...DEFAULTS, ...(typeof stored === 'object' && stored !== null ? stored : {}) }
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
