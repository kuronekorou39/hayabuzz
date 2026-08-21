import { el } from '../util/dom.js'
import { mountHost } from './host.js'
import { mountPlayer } from './player.js'
import { mascotSprite, spriteFormatReady } from './sprites.js'

export function mountTop(app) {
  const hero = el('img', { class: 'mascot-hero', alt: '' })
  spriteFormatReady.then(() => {
    hero.src = mascotSprite('hero')
  })
  app.replaceChildren(
    el('div', { class: 'screen top-screen' }, [
      hero,
      el('h1', { class: 'logo', text: 'Hayabuzz' }),
      el('p', { class: 'tagline', text: 'スマホが早押しボタンになるクイズアプリ' }),
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
