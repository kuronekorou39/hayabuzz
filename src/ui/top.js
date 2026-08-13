import mascotHero from '../assets/mascot/hero.webp'
import { el } from '../util/dom.js'
import { mountHost } from './host.js'
import { mountPlayer } from './player.js'

export function mountTop(app) {
  app.replaceChildren(
    el('div', { class: 'screen top-screen' }, [
      el('img', { class: 'mascot-hero', src: mascotHero, alt: '' }),
      el('h1', { class: 'logo', text: 'Hayabuzz' }),
      el('p', { class: 'tagline', text: 'サーバレスP2P 早押しクイズ' }),
      el('button', {
        class: 'btn btn-primary btn-big',
        text: '出題者として部屋を作る',
        onclick: () => mountHost(app),
      }),
      el('button', {
        class: 'btn btn-big',
        text: '回答者として参加する',
        onclick: () => mountPlayer(app, {}),
      }),
    ]),
  )
}
