import { playBuzz, playCorrect, playWrong, playYourTurn, setSoundEnabled, unlockAudio } from '../audio.js'
import { CONFIG } from '../config.js'
import { PHASE, PHASE_LABEL } from '../game/phases.js'
import { MSG, PROTO_VERSION, validateMessage } from '../net/protocol.js'
import { createTransport } from '../net/transport.js'
import { loadPrefs, savePrefs } from '../prefs.js'
import { el } from '../util/dom.js'
import { randomCode } from '../util/random.js'
import { BUZZER_STYLES, getBuzzerStyle } from './buzzer-styles.js'

const SESSION_KEY = 'hayabuzz.sessionId'
const NICK_KEY = 'hayabuzz.nick' // タブのセッション内のみ保持（localStorage には保存しない）

// 一時切断→再接続で得点を引き継ぐためのセッションID（タブ単位で保持）
function getSessionId() {
  let sid = sessionStorage.getItem(SESSION_KEY)
  if (!sid) {
    sid = randomCode(CONFIG.sessionIdLen)
    sessionStorage.setItem(SESSION_KEY, sid)
  }
  return sid
}

function goTop() {
  history.replaceState(null, '', location.pathname + location.search)
  location.reload()
}

// ---- 参加フォーム ----

export function mountPlayer(app, { roomCode = '' } = {}) {
  const codeInput = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'ルームコード',
    maxlength: 32,
    autocapitalize: 'characters',
    autocomplete: 'off',
    spellcheck: 'false',
    value: roomCode,
  })
  const nickInput = el('input', {
    class: 'input',
    type: 'text',
    placeholder: 'ニックネーム',
    maxlength: CONFIG.nickMaxLen,
    autocomplete: 'off',
    value: sessionStorage.getItem(NICK_KEY) ?? '',
  })
  const errorEl = el('p', { class: 'form-error', text: '' })

  // 入力中に大文字へそろえる（コードは大文字のみ）
  codeInput.addEventListener('input', () => {
    const pos = codeInput.selectionStart
    codeInput.value = codeInput.value.toUpperCase()
    codeInput.setSelectionRange(pos, pos)
  })
  codeInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') nickInput.focus()
  })

  function join() {
    unlockAudio() // AudioContext はユーザー操作を起点に resume する（モバイル対策）
    const code = codeInput.value.trim().toUpperCase()
    const nick = nickInput.value.trim()
    if (code.length < 4) {
      errorEl.textContent = 'ルームコードを入力してください'
      return
    }
    if (nick === '') {
      errorEl.textContent = 'ニックネームを入力してください'
      return
    }
    sessionStorage.setItem(NICK_KEY, nick) // 再接続（リロード）時の再入力を省く
    // 再読み込みで同じ部屋に再参加できるよう URL に部屋コードを残す
    history.replaceState(null, '', `#/join/${code}`)
    startGame(app, code, nick)
  }

  nickInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') join()
  })

  app.replaceChildren(
    el('div', { class: 'screen top-screen' }, [
      el('h1', { class: 'logo', text: 'Hayabuzz' }),
      el('p', { class: 'tagline', text: '回答者として参加' }),
      codeInput,
      nickInput,
      errorEl,
      el('button', { class: 'btn btn-primary btn-big', text: '参加する', onclick: join }),
      el('button', { class: 'btn btn-ghost', text: 'トップへ戻る', onclick: goTop }),
    ]),
  )
  ;(roomCode !== '' ? nickInput : codeInput).focus()
}

// ---- ゲーム画面 ----

function startGame(app, roomCode, nick) {
  const sessionId = getSessionId()
  const transport = createTransport({ role: 'player' })
  const prefs = loadPrefs()
  setSoundEnabled(prefs.sound)

  let hostPeerId = null // welcome をくれたピア＝host。以後 host とのみ通信する（スター型）
  let playerId = null
  let snapshot = null
  let peersSeen = 0
  let pressedKey = null // 押下済みの受付回を識別する（再開放で armedAt が変わると再度押せる）
  let joinTimer = null

  // --- 通知トースト（結果や順位は常設せず、一時表示で伝える） ---
  const toastBox = el('div', { class: 'toasts' })

  function showToast(text, kind = '') {
    const toast = el('div', { class: `toast ${kind}`, text })
    toastBox.append(toast)
    setTimeout(() => toast.classList.add('fade'), 3200)
    setTimeout(() => toast.remove(), 3900)
  }

  // --- DOM ---
  const statusDot = el('span', { class: 'dot wait' })
  const statusText = el('span', { class: 'status-text', text: '接続中' })
  const phaseEl = el('div', { class: 'phase-banner', text: '接続中…' })
  const questionEl = el('div', { class: 'question-text card question-clamp', text: '' })

  // 早押しボタン: 台（base）とボタン（cap）の2層 + 状態ラベル
  const buzzerBase = el('img', { class: 'buzzer-base', alt: '', draggable: 'false' })
  const buzzerCap = el('img', { class: 'buzzer-cap', alt: '', draggable: 'false' })
  const buzzerLabel = el('span', { class: 'buzzer-label', text: '接続中…' })
  const buzzerRig = el('div', { class: 'buzzer-rig' }, [buzzerBase, buzzerCap, buzzerLabel])
  const buzzer = el('button', { class: 'buzzer' }, [buzzerRig])

  // 下部バー: 自分の得点の要約 + 得点表を開くボタン
  const meSummary = el('span', { class: 'me-summary', text: '—' })
  const boardRows = el('div', { class: 'board-rows' })
  const boardOverlay = el('div', { class: 'overlay board-overlay hidden' }, [
    el('div', { class: 'card board-card' }, [el('h2', { text: '得点表' }), boardRows]),
    el('button', { class: 'btn btn-primary', text: '閉じる', onclick: () => boardOverlay.classList.add('hidden') }),
  ])
  const bottomBar = el('div', { class: 'bottom-bar' }, [
    meSummary,
    el('button', { class: 'btn btn-small', text: '得点表', onclick: () => boardOverlay.classList.remove('hidden') }),
  ])

  // --- 設定（ボタンの見た目 / 効果音） ---
  let styleClass = 'style-simple'
  let stateClasses = []

  function applyBuzzerClasses() {
    buzzer.className = ['buzzer', styleClass, ...stateClasses].join(' ')
  }

  function applyBuzzerStyle(styleId) {
    const style = getBuzzerStyle(styleId)
    if (style.base === undefined) {
      styleClass = 'style-simple'
    } else {
      styleClass = 'style-img'
      buzzerBase.src = style.base
      buzzerCap.src = style.cap
      buzzer.style.setProperty('--base-clip', style.baseClip)
      buzzer.style.setProperty('--cap-clip', style.capClip)
      buzzer.style.setProperty('--cap-w', style.capW)
      buzzer.style.setProperty('--glow', style.glow)
    }
    applyBuzzerClasses()
  }

  const styleSelect = el(
    'select',
    { class: 'input' },
    BUZZER_STYLES.map((s) => el('option', { value: s.id, text: s.label })),
  )
  styleSelect.value = getBuzzerStyle(prefs.buttonStyle).id
  styleSelect.addEventListener('change', () => {
    prefs.buttonStyle = styleSelect.value
    savePrefs(prefs)
    applyBuzzerStyle(prefs.buttonStyle)
  })

  const soundCheck = el('input', { type: 'checkbox' })
  soundCheck.checked = prefs.sound
  soundCheck.addEventListener('change', () => {
    prefs.sound = soundCheck.checked
    savePrefs(prefs)
    setSoundEnabled(prefs.sound)
  })

  const settingsCard = el('div', { class: 'card settings-card hidden' }, [
    el('label', { class: 'settings-row' }, [el('span', { text: 'ボタンの見た目' }), styleSelect]),
    el('label', { class: 'settings-row' }, [el('span', { text: '効果音' }), soundCheck]),
  ])
  const settingsBtn = el('button', {
    class: 'btn btn-small',
    text: '設定',
    onclick: () => settingsCard.classList.toggle('hidden'),
  })

  // --- 接続オーバーレイ（接続中/エラー/部屋終了の全画面表示） ---
  const overlayTitle = el('h2', { text: '' })
  const overlayMessage = el('p', { text: '' })
  const overlayButtons = el('div', { class: 'btn-row' })
  const spinner = el('div', { class: 'spinner' })
  const overlay = el('div', { class: 'overlay conn-overlay' }, [spinner, overlayTitle, overlayMessage, overlayButtons])

  function showOverlay(title, message, buttons, { withSpinner = false } = {}) {
    overlayTitle.textContent = title
    overlayMessage.textContent = message
    overlayButtons.replaceChildren(...buttons)
    spinner.classList.toggle('hidden', !withSpinner)
    overlay.classList.remove('hidden')
  }

  function hideOverlay() {
    overlay.classList.add('hidden')
  }

  app.replaceChildren(
    el('div', { class: 'screen player-screen' }, [
      el('div', { class: 'topbar' }, [
        el('div', {}, [
          el('span', { class: 'brand', text: 'Hayabuzz' }),
          el('span', { class: 'role', text: '回答者' }),
        ]),
        el('div', { class: 'status' }, [statusDot, statusText, settingsBtn]),
      ]),
      settingsCard,
      phaseEl,
      questionEl,
      buzzer,
      bottomBar,
    ]),
    overlay,
    boardOverlay,
    toastBox,
  )
  applyBuzzerStyle(prefs.buttonStyle)

  showOverlay('接続しています…', `ルームコード: ${roomCode}`, [
    el('button', { class: 'btn', text: 'キャンセル', onclick: goTop }),
  ], { withSpinner: true })

  function setStatus(kind, label) {
    statusDot.className = `dot ${kind}`
    statusText.textContent = label
  }

  // 画面スリープでの切断を防ぐ（対応端末のみ・失敗は無視）
  async function keepAwake() {
    try {
      await navigator.wakeLock?.request('screen')
    } catch {
      // 非対応・省電力モード等では取得できないが、ゲームは続行できる
    }
  }
  keepAwake()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake()
  })

  // --- 早押し ---

  function pressKey() {
    return snapshot !== null ? `${snapshot.qid}:${snapshot.armedAt}` : null
  }

  function hasPressed() {
    if (snapshot === null) return false
    return pressedKey === pressKey() || snapshot.order.some((o) => o.playerId === playerId)
  }

  function canBuzz() {
    return (
      hostPeerId !== null &&
      snapshot !== null &&
      snapshot.phase === PHASE.ARMED &&
      !snapshot.excluded.includes(playerId) &&
      !hasPressed()
    )
  }

  const onPress = (ev) => {
    const t = performance.now() // 押下時刻を最初に確定させる
    ev.preventDefault()
    unlockAudio()
    if (!canBuzz()) return
    pressedKey = pressKey()
    transport.send({ type: MSG.BUZZ, qid: snapshot.qid, t }, hostPeerId)
    navigator.vibrate?.(50)
    // 押下音は部屋のルールに従う。既定（winner）では回答権を得た端末でのみ鳴る
    if (snapshot.rules.pressSound === 'all') playBuzz()
    renderState()
  }
  if (window.PointerEvent) {
    buzzer.addEventListener('pointerdown', onPress)
  } else {
    // iOS 12 Safari 等は PointerEvent 非対応。touchstart の preventDefault が
    // 後続の合成 mousedown を抑止するため二重送信にはならない
    buzzer.addEventListener('touchstart', onPress, { passive: false })
    buzzer.addEventListener('mousedown', onPress)
  }
  buzzer.addEventListener('contextmenu', (ev) => ev.preventDefault())

  // --- 状態描画（host から配信されたスナップショットを描くだけ） ---

  function renderState() {
    if (snapshot === null) return
    phaseEl.textContent = PHASE_LABEL[snapshot.phase]
    phaseEl.className = `phase-banner phase-${snapshot.phase}`
    questionEl.textContent = snapshot.questionText !== '' ? snapshot.questionText : '（口頭で出題）'

    const excluded = snapshot.excluded.includes(playerId)
    stateClasses = []
    if (excluded) {
      stateClasses.push('dim')
      buzzerLabel.textContent = '誤答のため待機'
    } else if (snapshot.phase === PHASE.ARMED) {
      if (hasPressed()) {
        stateClasses.push('pressed')
        buzzerLabel.textContent = '押した！'
      } else {
        stateClasses.push('armed')
        buzzerLabel.textContent = '押せ！'
      }
    } else if (snapshot.phase === PHASE.LOCKED) {
      if (snapshot.activePlayerId === playerId) {
        stateClasses.push('mine')
        buzzerLabel.textContent = '回答してください！'
      } else {
        stateClasses.push(hasPressed() ? 'pressed' : 'dim')
        const active = snapshot.players.find((p) => p.playerId === snapshot.activePlayerId)
        buzzerLabel.textContent = active !== undefined ? `${active.nick}さんが回答中` : '回答待ち'
      }
    } else if (snapshot.phase === PHASE.QUESTION) {
      stateClasses.push('dim')
      buzzerLabel.textContent = 'まだ押せません'
    } else if (snapshot.phase === PHASE.RESULT) {
      stateClasses.push('dim')
      buzzerLabel.textContent = '次の問題待ち'
    } else {
      stateClasses.push('dim')
      buzzerLabel.textContent = '待機中'
    }
    applyBuzzerClasses()

    // 自分の得点の要約（得点順の順位）
    const me = snapshot.players.find((p) => p.playerId === playerId)
    if (me !== undefined) {
      const scoreRank = 1 + snapshot.players.filter((p) => p.score > me.score).length
      meSummary.textContent = `${me.score}点 · ${scoreRank}位/${snapshot.players.length}人`
    } else {
      meSummary.textContent = '—'
    }

    // 得点表（オーバーレイの中身。開いたときに最新になるよう常に更新しておく）
    const board = [...snapshot.players].sort((a, b) => b.score - a.score)
    boardRows.replaceChildren(
      ...board.map((p) =>
        el('div', { class: p.playerId === playerId ? 'board-row me' : 'board-row' }, [
          el('span', { class: p.connected ? 'dot on' : 'dot off' }),
          el('span', { class: 'board-nick', text: p.nick }),
          ...(p.handicapMs > 0
            ? [el('span', { class: 'handicap-note', text: `ハンデ+${p.handicapMs}ms` })]
            : []),
          el('span', { class: 'board-score', text: `${p.score}点` }),
        ]),
      ),
    )
  }

  // 前回スナップショットとの差分から効果音・トーストを出す
  function notifyTransitions(prev, next) {
    // 自分の押下順位が確定した
    const wasRanked = prev.order.some((o) => o.playerId === playerId)
    const rankIndex = next.order.findIndex((o) => o.playerId === playerId)
    if (!wasRanked && rankIndex >= 0) {
      const deltaMs = next.order[rankIndex].deltaMs
      showToast(rankIndex === 0 ? '1位！' : `${rankIndex + 1}位 (+${deltaMs.toFixed(1)}ms)`, rankIndex === 0 ? 'ok' : '')
    }
    // 回答権が自分に回ってきた
    if (next.phase === PHASE.LOCKED && next.activePlayerId === playerId && prev.activePlayerId !== playerId) {
      playYourTurn()
    }
    // 自分が誤答と判定された（除外に追加された）
    if (next.excluded.includes(playerId) && !prev.excluded.includes(playerId)) {
      playWrong()
      showToast('不正解…', 'ng')
    }
    // 判定結果が出た
    if (next.result !== null && prev.result === null) {
      if (next.result.correct) {
        playCorrect()
        const winner = next.players.find((p) => p.playerId === next.result.playerId)
        showToast(
          next.result.playerId === playerId
            ? '正解！ +1点'
            : `${winner !== undefined ? winner.nick : '？'} さんが正解`,
          'ok',
        )
      } else {
        playWrong()
        showToast('正解者なし', 'ng')
      }
    }
  }

  // --- 通信 ---

  function acceptWelcome(msg, peerId) {
    clearTimeout(joinTimer)
    hostPeerId = peerId
    playerId = msg.playerId
    hideOverlay()
    setStatus('on', msg.resumed ? '再接続しました' : '接続済み')
    if (msg.resumed) showToast('得点を引き継ぎました', 'ok')
  }

  function showRoomClosed() {
    setStatus('off', '切断')
    showOverlay('部屋が終了しました', '出題者との接続が切れました。ホストなしでは続行できません。', [
      el('button', { class: 'btn btn-primary', text: 'トップへ戻る', onclick: goTop }),
    ])
  }

  transport.onPeerJoin((peerId) => {
    peersSeen += 1
    // host が誰かはまだ不明なので、新しいピアごとに hello を送る。
    // 応答（welcome）を返すのは host だけで、他の player は無視する。
    if (hostPeerId === null) {
      transport.send({ type: MSG.HELLO, proto: PROTO_VERSION, sessionId, nick }, peerId)
    }
  })

  transport.onPeerLeave((peerId) => {
    if (peerId === hostPeerId) showRoomClosed()
  })

  transport.onMessage((raw, peerId) => {
    if (!validateMessage(raw)) return // スキーマ検証に落ちたメッセージは破棄
    if (hostPeerId === null) {
      if (raw.type === MSG.WELCOME) acceptWelcome(raw, peerId)
      else if (raw.type === MSG.REJECTED) {
        clearTimeout(joinTimer)
        setStatus('off', '切断')
        showOverlay('参加できませんでした', raw.reason, [
          el('button', { class: 'btn btn-primary', text: 'トップへ戻る', onclick: goTop }),
        ])
      }
      return
    }
    if (peerId !== hostPeerId) return // host 以外からのメッセージは無視（スター型）
    switch (raw.type) {
      case MSG.PING:
        transport.send({ type: MSG.PONG, seq: raw.seq, t: performance.now() }, hostPeerId)
        break
      case MSG.STATE: {
        const prev = snapshot
        snapshot = raw
        if (prev !== null) notifyTransitions(prev, raw)
        renderState()
        break
      }
    }
  })

  // 対称NAT等で確立できない場合に無限にスピナーを回さない
  joinTimer = setTimeout(() => {
    if (hostPeerId !== null) return
    setStatus('off', '未接続')
    const message =
      peersSeen === 0
        ? 'この回線では P2P 接続を確立できない可能性があります（対称NAT等）。別の回線（モバイル回線など）でお試しください。'
        : 'ホストが見つかりませんでした。ルームコードが正しいか、出題者の画面が開いているか確認してください。'
    showOverlay('接続できませんでした', message, [
      el('button', { class: 'btn btn-primary', text: '再試行', onclick: () => location.reload() }),
      el('button', { class: 'btn', text: 'トップへ戻る', onclick: goTop }),
    ])
  }, CONFIG.joinTimeoutMs)

  window.addEventListener('pagehide', () => transport.leave())
  transport.join(roomCode)
}
