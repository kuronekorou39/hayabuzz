import { el } from '../util/dom.js'

// 一時表示の通知。画面上部に出て数秒で消える。
// 画面のどこからでも使えるよう body 直下に置く（オーバーレイの中に文字で残すと、
// 用が済んだ後も表示され続けてしまう）
let box = null

export function showToast(text, kind = '') {
  if (box === null || !box.isConnected) {
    box = el('div', { class: 'toasts' })
    document.body.append(box)
  }
  const toast = el('div', { class: `toast ${kind}`, text })
  box.append(toast)
  setTimeout(() => toast.classList.add('fade'), 3200)
  setTimeout(() => toast.remove(), 3900)
}
