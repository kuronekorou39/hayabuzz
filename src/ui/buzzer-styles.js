// 早押しボタンの見た目バリエーション。
// 台（base）とボタン（cap）は別画像で、押し込みは cap の transform で表現する。
// 画像は白背景つきスプライトなので clip-path で形に沿って切り抜く。
// base / cap はスプライト名（URL は sprites.js が形式込みで解決する）。
// スプライトの再生成: node scripts/extract-buzzer-sprites.mjs
//
// スプライトは「形状の中心 = 画像の中心、形状の直径 = 画像の94%」に正規化して
// 切り出してある（extract スクリプトの FILL と対応）。つまり形状の縁は 3%〜97% にあり、
// clip はそこから白フチのにじみ分(0.3%)だけ内側を切る。capDx/capDy は個別の微調整用。
// 八角形は元写真に僅かなパースがあり正八角形でないため、スプライトの実エッジを
// 画素計測した頂点を使う（角の開始位置・斜め辺の傾き・下半分の窄まりを反映）
const OCT_BASE = 'polygon(33.2% 3.7%, 66.8% 3.7%, 96.3% 31.7%, 95.2% 70.8%, 69.3% 96.9%, 30.5% 96.9%, 4.8% 70.8%, 3.8% 31.7%)'
const OCT_CAP = 'polygon(32.1% 3.7%, 67.9% 3.7%, 96% 31.2%, 94.9% 69.8%, 69.2% 96.3%, 30.8% 96.3%, 5.2% 69.8%, 4% 31.2%)'
const GRAY_BASE = 'inset(3.3% round 11%)'
const ROUND_CAP = 'circle(46.7%)'

const GLOW = {
  red: 'rgba(255, 90, 70, 0.85)',
  blue: 'rgba(80, 150, 255, 0.85)',
  yellow: 'rgba(255, 210, 60, 0.85)',
  green: 'rgba(70, 230, 130, 0.85)',
  orange: 'rgba(255, 170, 60, 0.85)',
}

export const BUZZER_STYLES = [
  { id: 'classic', label: 'クラシック（黒×赤）', base: 'base-round-black', cap: 'cap-round-red-big', baseClip: 'circle(46.7%)', capClip: ROUND_CAP, capW: '60%', glow: GLOW.red },
  { id: 'red', label: 'レッド', base: 'base-square-gray', cap: 'cap-round-red', baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.red },
  { id: 'blue', label: 'ブルー', base: 'base-square-gray', cap: 'cap-round-blue', baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.blue },
  { id: 'yellow', label: 'イエロー', base: 'base-square-gray', cap: 'cap-round-yellow', baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.yellow },
  { id: 'green', label: 'グリーン', base: 'base-square-gray', cap: 'cap-round-green', baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.green },
  { id: 'silver', label: 'シルバー（角）', base: 'base-square-silver', cap: 'cap-square-blue', baseClip: 'inset(3.3% round 10%)', capClip: 'inset(3.4% round 16%)', capW: '62%', glow: GLOW.blue },
  { id: 'wood', label: '木製（八角）', base: 'base-oct-wood', cap: 'cap-oct-orange', baseClip: OCT_BASE, capClip: OCT_CAP, capW: '59%', glow: GLOW.orange },
  { id: 'glass', label: 'ガラス（発光）', base: 'base-round-glass', cap: 'cap-round-green-glow', baseClip: 'circle(46.7%)', capClip: ROUND_CAP, capW: '56%', glow: GLOW.green },
  { id: 'simple', label: 'シンプル（画像なし）' },
]

export function getBuzzerStyle(id) {
  return BUZZER_STYLES.find((s) => s.id === id) ?? BUZZER_STYLES[0]
}
