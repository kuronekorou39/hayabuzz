// DOM 構築ヘルパ。表示文字列は常に textContent（text 属性）経由で設定する。
// innerHTML への文字列連結はプロジェクト全体で禁止。
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
