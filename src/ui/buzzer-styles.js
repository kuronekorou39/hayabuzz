// 早押しボタンの見た目バリエーション。
// 台（base）とボタン（cap）は別画像で、押し込みは cap の transform で表現する。
// 画像は白背景つきスプライトなので clip-path で形に沿って切り抜く。
// base / cap はスプライト名（URL は sprites.js が形式込みで解決する）。
// スプライトの再生成: node scripts/extract-buzzer-sprites.mjs
const OCT = 'polygon(30% 3%, 70% 3%, 97% 30%, 97% 70%, 70% 97%, 30% 97%, 3% 70%, 3% 30%)'
const GRAY_BASE = 'inset(2.5% round 11%)'
const ROUND_CAP = 'circle(45%)'

const GLOW = {
  red: 'rgba(255, 90, 70, 0.85)',
  blue: 'rgba(80, 150, 255, 0.85)',
  yellow: 'rgba(255, 210, 60, 0.85)',
  green: 'rgba(70, 230, 130, 0.85)',
  orange: 'rgba(255, 170, 60, 0.85)',
}

export const BUZZER_STYLES = [
  { id: 'classic', label: 'クラシック（黒×赤）', base: 'base-round-black', cap: 'cap-round-red-big', baseClip: 'circle(47.5%)', capClip: ROUND_CAP, capW: '62%', glow: GLOW.red },
  { id: 'red', label: 'レッド', base: 'base-square-gray', cap: 'cap-round-red', baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.red },
  { id: 'blue', label: 'ブルー', base: 'base-square-gray', cap: 'cap-round-blue', baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.blue },
  { id: 'yellow', label: 'イエロー', base: 'base-square-gray', cap: 'cap-round-yellow', baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.yellow },
  { id: 'green', label: 'グリーン', base: 'base-square-gray', cap: 'cap-round-green', baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.green },
  { id: 'silver', label: 'シルバー（角）', base: 'base-square-silver', cap: 'cap-square-blue', baseClip: 'inset(4.5% round 10%)', capClip: 'inset(4% round 16%)', capW: '64%', glow: GLOW.blue },
  { id: 'wood', label: '木製（八角）', base: 'base-oct-wood', cap: 'cap-oct-orange', baseClip: OCT, capClip: OCT, capW: '60%', glow: GLOW.orange },
  { id: 'glass', label: 'ガラス（発光）', base: 'base-round-glass', cap: 'cap-round-green-glow', baseClip: 'circle(46.5%)', capClip: ROUND_CAP, capW: '58%', glow: GLOW.green },
  { id: 'simple', label: 'シンプル（画像なし）' },
]

export function getBuzzerStyle(id) {
  return BUZZER_STYLES.find((s) => s.id === id) ?? BUZZER_STYLES[0]
}
