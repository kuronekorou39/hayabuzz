// DOM 構築ヘルパ。表示文字列は常に textContent（text 属性）経由で設定する。
// innerHTML への文字列連結はプロジェクト全体で禁止。
// オーバーレイの背景（カードの外側）をタップしたら閉じる
export function backdropDismiss(...overlays) {
  for (const overlay of overlays) {
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) overlay.classList.add('hidden')
    })
  }
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2), value)
    } else if (value === true) node.setAttribute(key, '')
    else if (value !== false && value != null) node.setAttribute(key, value)
  }
  node.append(...children)
  return node
}
