import { el } from '../util/dom.js'

// 一時表示の通知。画面上部に出て数秒で消える。
// 画面のどこからでも使えるよう body 直下に置く（オーバーレイの中に文字で残すと、
// 用が済んだ後も表示され続けてしまう）
let box = null
const live = new Map() // 表示中の文言 → { toast, show }（同じ知らせを重ねないため）

export function showToast(text, kind = '') {
  if (box === null || !box.isConnected) {
    box = el('div', { class: 'toasts' })
    document.body.append(box)
    live.clear()
  }
  // 同じ知らせが表示中なら重ねず、表示時間を延ばすだけにする（ボタンの連打で積み上がらないように）
  const current = live.get(text)
  if (current !== undefined) {
    current.show()
    return
  }
  const toast = el('div', { class: `toast ${kind}`, text })
  box.append(toast)
  let timers = []
  const show = () => {
    for (const timer of timers) clearTimeout(timer)
    toast.classList.remove('fade')
    timers = [
      setTimeout(() => toast.classList.add('fade'), 3200),
      setTimeout(() => {
        toast.remove()
        live.delete(text)
      }, 3900),
    ]
  }
  live.set(text, { toast, show })
  show()
}
