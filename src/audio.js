// 効果音。AudioContext は必ずユーザー操作を起点に生成・resume する（モバイル対策）。
let ctx = null
let enabled = true

// 設定の「効果音 ON/OFF」から呼ぶ
export function setSoundEnabled(value) {
  enabled = value
}

// 「参加」ボタン等のユーザー操作ハンドラ内から呼ぶこと
export function unlockAudio() {
  if (ctx === null) ctx = new AudioContext()
  if (ctx.state === 'suspended') ctx.resume()
}

function beep(freq, durationMs, type, volume = 0.15) {
  if (!enabled || ctx === null || ctx.state !== 'running') return
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = type
  osc.frequency.value = freq
  gain.gain.setValueAtTime(volume, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + durationMs / 1000)
}

// player: 早押しボタン押下音
export function playBuzz() {
  beep(880, 150, 'square')
}

// host: 誰かが押してロックされた通知音
export function playLock() {
  beep(523, 90, 'sine')
  setTimeout(() => beep(784, 180, 'sine'), 90)
}

// player: 回答権が回ってきた通知音
export function playYourTurn() {
  beep(660, 90, 'sine', 0.18)
  setTimeout(() => beep(990, 240, 'sine', 0.18), 95)
}

// 正解（ピンポーン）
export function playCorrect() {
  beep(784, 140, 'sine', 0.18)
  setTimeout(() => beep(1047, 450, 'sine', 0.18), 150)
}

// 不正解（ブッブー）
export function playWrong() {
  beep(147, 130, 'sawtooth', 0.16)
  setTimeout(() => beep(131, 420, 'sawtooth', 0.16), 170)
}
