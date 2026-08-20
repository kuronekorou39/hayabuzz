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
  const transport = createTransport({ role: 'host' })
  const game = new HostGame({
    send: (msg, peerId) => transport.send(msg, peerId),
    onChange: render,
  })

  transport.onMessage((raw, peerId) => {
    if (!validateMessage(raw)) return // スキーマ検証に落ちたメッセージは破棄
    game.handleMessage(raw, peerId)
  })
  transport.onPeerLeave((peerId) => game.handlePeerLeave(peerId))
  // host が消えると部屋ごと終了するため、参加者がいる間は誤リロード/誤クローズに確認を挟む
  window.addEventListener('beforeunload', (ev) => {
    const hasPlayers = [...game.players.values()].some((p) => p.connected)
    if (hasPlayers) {
      ev.preventDefault()
      ev.returnValue = ''
    }
  })
  window.addEventListener('pagehide', () => {
    game.destroy()
    transport.leave()
  })

  // --- 接続状態（ロビー/進行画面のヘッダーで共用） ---
  const statusDot = el('span', { class: 'dot on' })
  const statusText = el('span', { class: 'status-text', text: '部屋を公開中' })

  function topbar(extra = []) {
    return el('div', { class: 'topbar' }, [
      el('div', {}, [
        el('span', { class: 'brand', text: 'Hayabuzz' }),
        el('span', { class: 'role', text: '出題者' }),
      ]),
      el('div', { class: 'status' }, [statusDot, statusText, ...extra]),
    ])
  }

  // --- 共有カード（ロビーと進行中の共有オーバーレイで同じノードを使い回す） ---
  const urlInput = el('input', { class: 'input url-input', type: 'text', readonly: true, value: joinUrl })
  const copyBtn = el('button', { class: 'btn btn-small', text: 'コピー', onclick: copyUrl })
  const qrCanvas = el('canvas', { class: 'qr' })
  const shareCard = el('div', { class: 'card share-card' }, [
    el('h2', { text: 'ルームコード' }),
    el('div', { class: 'room-code', text: roomCode }),
    el('div', { class: 'url-row' }, [urlInput, copyBtn]),
    el('div', { class: 'qr-wrap' }, [qrCanvas]),
    el('p', { class: 'placeholder', text: 'QRコードの読み取りか、URLの共有で参加できます。ゲーム開始後も「共有」から表示できます。' }),
  ])

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

  // --- 参加者・得点カード（ロビーと進行画面で共用） ---
  const scoreRows = el('div', { class: 'score-rows' })
  const scorePlaceholder = el('p', { class: 'placeholder', text: 'まだ参加者がいません' })
  const scoreCard = el('div', { class: 'card' }, [
    el('h2', { text: '参加者・得点' }),
    scorePlaceholder,
    scoreRows,
  ])

  // --- 進行画面の部品 ---
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
  const resultLine = el('p', { class: 'result-line hidden', text: '' })
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

  // --- 進行中の共有オーバーレイ ---
  const shareOverlay = el('div', { class: 'overlay share-overlay hidden' })
  const shareBtn = el('button', { class: 'btn btn-small', text: '共有', onclick: () => {
    shareOverlay.replaceChildren(
      shareCard,
      el('button', { class: 'btn btn-primary', text: '閉じる', onclick: () => shareOverlay.classList.add('hidden') }),
    )
    shareOverlay.classList.remove('hidden')
  } })

  // --- ルール設定オーバーレイ（押下音・ハンデ） ---
  const pressSoundSelect = el('select', { class: 'input' }, [
    el('option', { value: 'winner', text: '回答権を得た人だけ鳴る' }),
    el('option', { value: 'all', text: '押した全員に鳴る' }),
  ])
  pressSoundSelect.addEventListener('change', () => game.setPressSound(pressSoundSelect.value))

  const handicapRows = el('div', { class: 'score-rows' })
  const handicapPlaceholder = el('p', { class: 'placeholder', text: 'まだ参加者がいません' })
  const rulesOverlay = el('div', { class: 'overlay rules-overlay hidden' }, [
    el('div', { class: 'card rules-card' }, [
      el('h2', { text: 'ルール設定' }),
      el('label', { class: 'settings-row' }, [el('span', { text: '押下音' }), pressSoundSelect]),
      el('h2', { text: 'ハンデ（押下時刻に加算するms）' }),
      handicapPlaceholder,
      handicapRows,
    ]),
    el('button', { class: 'btn btn-primary', text: '閉じる', onclick: () => rulesOverlay.classList.add('hidden') }),
  ])

  function openRules() {
    pressSoundSelect.value = game.rules.pressSound
    const players = [...game.players.values()]
    handicapPlaceholder.style.display = players.length === 0 ? '' : 'none'
    handicapRows.replaceChildren(
      ...players.map((p) => {
        const input = el('input', {
          class: 'input handicap-input',
          type: 'number',
          min: '0',
          max: '10000',
          step: '100',
        })
        input.value = String(p.handicapMs)
        input.addEventListener('change', () => game.setHandicap(p.sessionId, input.value))
        return el('div', { class: 'handicap-row' }, [
          el('span', { class: 'score-nick', text: p.nick }),
          input,
        ])
      }),
    )
    rulesOverlay.classList.remove('hidden')
  }

  const rulesBtn = el('button', { class: 'btn btn-small', text: 'ルール', onclick: openRules })

  // --- 画面: ロビー（参加者集め） → 進行 ---

  function showLobby() {
    app.replaceChildren(
      el('div', { class: 'screen host-screen' }, [
        topbar([rulesBtn]),
        shareCard,
        scoreCard,
        el('button', { class: 'btn btn-primary btn-big', text: 'クイズを開始', onclick: showGame }),
      ]),
      rulesOverlay,
    )
  }

  function showGame() {
    app.replaceChildren(
      el('div', { class: 'screen host-screen' }, [
        topbar([rulesBtn, shareBtn]),
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
          resultLine,
          el('div', { class: 'btn-row' }, [correctBtn, wrongNextBtn, wrongOpenBtn]),
          el('label', { class: 'settings-row' }, [el('span', { text: '効果音（この端末で鳴らす）' }), soundCheck]),
        ]),
        scoreCard,
      ]),
      shareOverlay,
      rulesOverlay,
    )
  }

  // --- 描画（game の状態を反映するだけ。状態遷移は HostGame が持つ） ---

  let prevPhase = game.phase

  function render() {
    if (game.phase === PHASE.LOCKED && prevPhase !== PHASE.LOCKED) playLock()
    prevPhase = game.phase

    const connectedCount = [...game.players.values()].filter((p) => p.connected).length
    statusText.textContent = `部屋を公開中 · 参加 ${connectedCount}人`

    phaseEl.textContent = PHASE_LABEL[game.phase]
    phaseEl.className = `phase-chip phase-${game.phase}`
    if (game.qid === 0) {
      currentQuestionEl.textContent = 'まだ問題がありません'
    } else {
      currentQuestionEl.textContent =
        game.questionText !== '' ? `第${game.qid}問: ${game.questionText}` : `第${game.qid}問（口頭で出題）`
    }

    // 受付中・判定中の「問題を表示」は進行中の問題を破棄してしまうため無効化する
    // （仕切り直したいときは「受付停止」で一旦戻す）
    showBtn.textContent = game.phase === PHASE.RESULT ? '次の問題を表示' : '問題を表示'
    showBtn.disabled = game.phase === PHASE.ARMED || game.phase === PHASE.LOCKED
    armBtn.disabled = game.phase !== PHASE.QUESTION
    stopBtn.disabled = game.phase !== PHASE.ARMED && game.phase !== PHASE.LOCKED
    const canJudge = game.phase === PHASE.LOCKED && game.activePlayerId !== null
    correctBtn.disabled = !canJudge
    wrongNextBtn.disabled = !canJudge
    wrongOpenBtn.disabled = !canJudge

    // 判定結果の表示
    if (game.result !== null) {
      if (game.result.correct) {
        const winner = game.players.get(game.result.playerId)
        resultLine.textContent = `正解: ${winner !== undefined ? winner.nick : '？'} さん（+1点）`
        resultLine.className = 'result-line ok'
      } else {
        resultLine.textContent = '正解者なし'
        resultLine.className = 'result-line ng'
      }
    } else {
      resultLine.className = 'result-line hidden'
    }

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

    // 参加者・得点（手動加減点つき）
    const players = [...game.players.values()]
    scorePlaceholder.style.display = players.length === 0 ? '' : 'none'
    scoreRows.replaceChildren(
      ...players.map((p) =>
        el('div', { class: 'score-row' }, [
          el('span', { class: p.connected ? 'dot on' : 'dot off' }),
          el('span', { class: 'score-nick', text: p.nick }),
          ...(p.handicapMs > 0
            ? [el('span', { class: 'handicap-note', text: `ハンデ+${p.handicapMs}ms` })]
            : []),
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

  showLobby()
  render()
  transport.join(roomCode)
}
