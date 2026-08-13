// 早押しボタンの見た目バリエーション。
// 台（base）とボタン（cap）は別画像で、押し込みは cap の transform で表現する。
// 画像は白背景つきスプライトなので clip-path で形に沿って切り抜く。
// スプライトの再生成: node scripts/extract-buzzer-sprites.mjs
import baseOctWood from '../assets/buzzer/base-oct-wood.webp'
import baseRoundBlack from '../assets/buzzer/base-round-black.webp'
import baseRoundGlass from '../assets/buzzer/base-round-glass.webp'
import baseSquareGray from '../assets/buzzer/base-square-gray.webp'
import baseSquareSilver from '../assets/buzzer/base-square-silver.webp'
import capOctOrange from '../assets/buzzer/cap-oct-orange.webp'
import capRoundBlue from '../assets/buzzer/cap-round-blue.webp'
import capRoundGreen from '../assets/buzzer/cap-round-green.webp'
import capRoundGreenGlow from '../assets/buzzer/cap-round-green-glow.webp'
import capRoundRed from '../assets/buzzer/cap-round-red.webp'
import capRoundRedBig from '../assets/buzzer/cap-round-red-big.webp'
import capRoundYellow from '../assets/buzzer/cap-round-yellow.webp'
import capSquareBlue from '../assets/buzzer/cap-square-blue.webp'

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
  { id: 'classic', label: 'クラシック（黒×赤）', base: baseRoundBlack, cap: capRoundRedBig, baseClip: 'circle(47.5%)', capClip: ROUND_CAP, capW: '62%', glow: GLOW.red },
  { id: 'red', label: 'レッド', base: baseSquareGray, cap: capRoundRed, baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.red },
  { id: 'blue', label: 'ブルー', base: baseSquareGray, cap: capRoundBlue, baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.blue },
  { id: 'yellow', label: 'イエロー', base: baseSquareGray, cap: capRoundYellow, baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.yellow },
  { id: 'green', label: 'グリーン', base: baseSquareGray, cap: capRoundGreen, baseClip: GRAY_BASE, capClip: ROUND_CAP, capW: '56%', glow: GLOW.green },
  { id: 'silver', label: 'シルバー（角）', base: baseSquareSilver, cap: capSquareBlue, baseClip: 'inset(4.5% round 10%)', capClip: 'inset(4% round 16%)', capW: '64%', glow: GLOW.blue },
  { id: 'wood', label: '木製（八角）', base: baseOctWood, cap: capOctOrange, baseClip: OCT, capClip: OCT, capW: '60%', glow: GLOW.orange },
  { id: 'glass', label: 'ガラス（発光）', base: baseRoundGlass, cap: capRoundGreenGlow, baseClip: 'circle(46.5%)', capClip: ROUND_CAP, capW: '58%', glow: GLOW.green },
  { id: 'simple', label: 'シンプル（画像なし）' },
]

export function getBuzzerStyle(id) {
  return BUZZER_STYLES.find((s) => s.id === id) ?? BUZZER_STYLES[0]
}
