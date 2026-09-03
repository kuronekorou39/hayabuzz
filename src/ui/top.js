import { loadHostRoom } from '../game/room-store.js'
import { el } from '../util/dom.js'
import { mountBankPage } from './bank-page.js'
import { mountHost } from './host.js'
import { mountPlayer } from './player.js'
import { mascotSprite, spriteFormatReady } from './sprites.js'

export function mountTop(app) {
  const hero = el('img', { class: 'mascot-hero', alt: '' })
  spriteFormatReady.then(() => {
    hero.src = mascotSprite('hero')
  })
  // この端末で進めていた部屋があれば、そこへ戻る導線を一番上に出す。
  // 新しい部屋を作ると前の部屋の保存は上書きされるので、その前に一度確かめる
  const saved = loadHostRoom()
  const resumeButtons =
    saved === null
      ? []
      : [
          el('button', {
            class: 'btn btn-primary btn-big',
            text: `前の部屋に戻る（${saved.roomCode}）`,
            onclick: () => mountHost(app, { saved }),
          }),
          el('p', { class: 'resume-note', text: '参加者と得点はそのまま。回答者はつなぎ直すだけで続けられます' }),
        ]
  function createRoom() {
    if (saved !== null) {
      const ok = window.confirm(`新しい部屋を作ると、前の部屋（${saved.roomCode}）には戻れなくなります。よろしいですか？`)
      if (!ok) return
    }
    mountHost(app)
  }
  app.replaceChildren(
    el('div', { class: 'screen top-screen' }, [
      hero,
      el('h1', { class: 'logo', text: 'Hayabuzz' }),
      el('p', { class: 'tagline', text: 'スマホが早押しボタンになるクイズアプリ' }),
      ...resumeButtons,
      el('button', {
        class: saved === null ? 'btn btn-primary btn-big' : 'btn btn-big',
        text: '出題者として部屋を作る',
        onclick: createRoom,
      }),
      el('button', {
        class: 'btn btn-big',
        text: '回答者として参加する',
        onclick: () => mountPlayer(app, {}),
      }),
      // 事前に問題を作り込むためのページ（部屋は開かない）
      el('button', {
        class: 'btn btn-ghost',
        text: '問題集を編集する',
        onclick: () => mountBankPage(app, { onBack: () => mountTop(app) }),
      }),
    ]),
  )
}
