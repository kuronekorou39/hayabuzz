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

// ポップアップ右上の×ボタン（範囲外タップでも閉じられるため、大きな閉じるボタンは置かない）
export function closeX(overlay) {
  return el('button', {
    class: 'overlay-close',
    text: '×',
    'aria-label': '閉じる',
    onclick: () => overlay.classList.add('hidden'),
  })
}

// カード + 右上の× を持つポップアップを作る。カード自体はスクロールするため、
// ×はスクロールしないラッパー側に置いて位置を固定する
export function popupOverlay(overlayClass, card) {
  const overlay = el('div', { class: `overlay ${overlayClass} hidden` })
  overlay.append(el('div', { class: 'overlay-card-wrap' }, [card, closeX(overlay)]))
  return overlay
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
