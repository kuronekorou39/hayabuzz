import QRCode from 'qrcode'
import { playCorrect, playLock, playWrong, setSoundEnabled, unlockAudio } from '../audio.js'
import { CONFIG } from '../config.js'
import { HostGame } from '../game/host-game.js'
import { PHASE, PHASE_LABEL } from '../game/phases.js'
import { validateMessage } from '../net/protocol.js'
import { createTransport } from '../net/transport.js'
import { loadPrefs, savePrefs } from '../prefs.js'
import { el } from '../util/dom.js'
import { randomCode } from '../util/random.js'

export function mountHost(app) {
  unlockAudio() // トップ画面のクリック（ユーザー操作）を起点に AudioContext を有効化
  const prefs = loadPrefs()
  setSoundEnabled(prefs.sound)

  const roomCode = randomCode(CONFIG.roomCodeLen)
  const joinUrl = `${location.origin}${location.pathname}${location.search}#/join/${roomCode}`
  const transport = createTransport()
  const game = new HostGame({
    send: (msg, peerId) => transport.send(msg, peerId),
    onChange: render,
  })

  transport.onMessage((raw, peerId) => {
    if (!validateMessage(raw)) return // スキーマ検証に落ちたメッセージは破棄
    game.handleMessage(raw, peerId)
  })
  transport.onPeerLeave((peerId) => game.handlePeerLeave(peerId))
  window.addEventListener('beforeunload', () => {
    game.destroy()
    transport.leave()
  })

  // --- DOM ---
  const statusDot = el('span', { class: 'dot on' })
  const statusText = el('span', { class: 'status-text', text: '部屋を公開中' })

  const urlInput = el('input', { class: 'input url-input', type: 'text', readonly: true, value: joinUrl })
  const copyBtn = el('button', { class: 'btn btn-small', text: 'コピー', onclick: copyUrl })
  const qrCanvas = el('canvas', { class: 'qr' })

  const questionInput = el('textarea', {
    class: 'input question-input',
    rows: '3',
    maxlength: CONFIG.questionMaxLen,
    placeholder: '問題文（空のまま口頭で読み上げてもOK）',
  })
  const showBtn = el('button', { class: 'btn btn-primary', text: '問題を表示', onclick: () => {
    game.showQuestion(questionInput.value)
    questionInput.value = ''
  } })
  const armBtn = el('button', { class: 'btn btn-arm', text: '早押し開始', onclick: () => game.arm() })
  const stopBtn = el('button', { class: 'btn', text: '受付停止', onclick: () => game.stop() })

  const phaseEl = el('span', { class: 'phase-chip', text: PHASE_LABEL[PHASE.WAITING] })
  const currentQuestionEl = el('div', { class: 'question-text', text: 'まだ問題がありません' })
  const orderList = el('ol', { class: 'order-list' })
  const orderPlaceholder = el('p', { class: 'placeholder', text: 'まだ誰も押していません' })
  const correctBtn = el('button', { class: 'btn btn-ok', text: '正解', onclick: () => {
    playCorrect()
    game.judgeCorrect()
  } })
  const wrongNextBtn = el('button', { class: 'btn btn-ng', text: '不正解→次点へ', onclick: () => {
    playWrong()
    game.judgeWrongNext()
  } })
  const wrongOpenBtn = el('button', { class: 'btn btn-ng', text: '不正解→全員再開放', onclick: () => {
    playWrong()
    game.judgeWrongReopen()
  } })

  const soundCheck = el('input', { type: 'checkbox' })
  soundCheck.checked = prefs.sound
  soundCheck.addEventListener('change', () => {
    prefs.sound = soundCheck.checked
    savePrefs(prefs)
    setSoundEnabled(prefs.sound)
  })

  const scoreRows = el('div', { class: 'score-rows' })
  const scorePlaceholder = el('p', { class: 'placeholder', text: '参加者を待っています。QRコードまたはURLを共有してください。' })

  app.replaceChildren(
    el('div', { class: 'screen host-screen' }, [
      el('div', { class: 'topbar' }, [
        el('div', {}, [
          el('span', { class: 'brand', text: 'Hayabuzz' }),
          el('span', { class: 'role', text: '出題者' }),
        ]),
        el('div', { class: 'status' }, [statusDot, statusText]),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: 'ルームコード' }),
        el('div', { class: 'room-code', text: roomCode }),
        el('div', { class: 'url-row' }, [urlInput, copyBtn]),
        el('div', { class: 'qr-wrap' }, [qrCanvas]),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: '問題' }),
        questionInput,
        el('div', { class: 'btn-row' }, [showBtn, armBtn, stopBtn]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'topbar' }, [el('h2', { text: '進行' }), phaseEl]),
        currentQuestionEl,
        orderPlaceholder,
        orderList,
        el('div', { class: 'btn-row' }, [correctBtn, wrongNextBtn, wrongOpenBtn]),
        el('label', { class: 'settings-row' }, [el('span', { text: '効果音（この端末で鳴らす）' }), soundCheck]),
      ]),
      el('div', { class: 'card' }, [
        el('h2', { text: '得点表' }),
        scorePlaceholder,
        scoreRows,
      ]),
    ]),
  )

  QRCode.toCanvas(qrCanvas, joinUrl, { width: 168, margin: 2 }).catch(() => {
    qrCanvas.replaceWith(el('p', { class: 'placeholder', text: 'QRコードを生成できませんでした' }))
  })

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(joinUrl)
      copyBtn.textContent = 'コピーしました'
    } catch {
      urlInput.select()
      copyBtn.textContent = '選択しました'
    }
    setTimeout(() => {
      copyBtn.textContent = 'コピー'
    }, 1500)
  }

  // --- 描画（game の状態を反映するだけ。状態遷移は HostGame が持つ） ---

  let prevPhase = game.phase

  function render() {
    if (game.phase === PHASE.LOCKED && prevPhase !== PHASE.LOCKED) playLock()
    prevPhase = game.phase

    const connectedCount = [...game.players.values()].filter((p) => p.connected).length
    statusText.textContent = `部屋を公開中 · 参加 ${connectedCount}人`

    phaseEl.textContent = PHASE_LABEL[game.phase]
    if (game.qid === 0) {
      currentQuestionEl.textContent = 'まだ問題がありません'
    } else {
      currentQuestionEl.textContent =
        game.questionText !== '' ? `第${game.qid}問: ${game.questionText}` : `第${game.qid}問（問題文なし）`
    }

    showBtn.textContent = game.phase === PHASE.RESULT ? '次の問題を表示' : '問題を表示'
    armBtn.disabled = game.phase !== PHASE.QUESTION
    stopBtn.disabled = game.phase !== PHASE.ARMED
    const canJudge = game.phase === PHASE.LOCKED && game.activePlayerId !== null
    correctBtn.disabled = !canJudge
    wrongNextBtn.disabled = !canJudge
    wrongOpenBtn.disabled = !canJudge

    // 押下順リスト（1位からのms差）
    orderPlaceholder.style.display = game.order.length === 0 ? '' : 'none'
    orderList.replaceChildren(
      ...game.order.map((entry) => {
        const player = game.players.get(entry.playerId)
        const badges = []
        if (entry.playerId === game.activePlayerId) {
          badges.push(el('span', { class: 'badge active', text: '回答権' }))
        }
        if (game.excluded.has(entry.playerId)) {
          badges.push(el('span', { class: 'badge ng', text: '誤答' }))
        }
        return el('li', { class: 'order-row' }, [
          el('span', { class: 'order-nick', text: player !== undefined ? player.nick : '？' }),
          el('span', { class: 'order-delta', text: `+${entry.deltaMs.toFixed(1)}ms` }),
          ...badges,
        ])
      }),
    )

    // 得点表（手動加減点つき）
    const players = [...game.players.values()]
    scorePlaceholder.style.display = players.length === 0 ? '' : 'none'
    scoreRows.replaceChildren(
      ...players.map((p) =>
        el('div', { class: 'score-row' }, [
          el('span', { class: p.connected ? 'dot on' : 'dot off' }),
          el('span', { class: 'score-nick', text: p.nick }),
          el('span', {
            class: 'score-rtt',
            text: p.sync.rtt !== null ? `RTT ${Math.round(p.sync.rtt)}ms` : '',
          }),
          el('span', { class: 'score-value', text: String(p.score) }),
          el('button', { class: 'btn btn-mini', text: '−', onclick: () => game.adjustScore(p.sessionId, -1) }),
          el('button', { class: 'btn btn-mini', text: '＋', onclick: () => game.adjustScore(p.sessionId, 1) }),
        ]),
      ),
    )
  }

  render()
  transport.join(roomCode)
}
