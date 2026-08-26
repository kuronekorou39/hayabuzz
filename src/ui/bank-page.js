import { loadBank } from '../game/question-bank.js'
import { el } from '../util/dom.js'
import { createBankPanel } from './question-bank-ui.js'

// 問題集の編集専用ページ。部屋を開かない（＝P2P接続を持たない）ので、
// 大きい画面でじっくり作り込んでも進行中の接続に影響しない。
export function mountBankPage(app, { onBack }) {
  const panel = createBankPanel({ items: loadBank() })
  app.replaceChildren(
    el('div', { class: 'screen bank-page' }, [
      el('div', { class: 'topbar' }, [
        el('div', {}, [
          el('span', { class: 'brand', text: 'Hayabuzz' }),
          el('span', { class: 'role', text: '問題集' }),
        ]),
        el('button', { class: 'btn btn-small', text: 'トップへ戻る', onclick: onBack }),
      ]),
      panel.root,
      el('p', { class: 'placeholder', text: 'ここで作った問題は、出題者画面の「問題集」からそのまま出題できます' }),
    ]),
  )
}
