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
  })
  const errorEl = el('p', { class: 'form-error', text: '' })

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
  const transport = createTransport()
  const prefs = loadPrefs()
  setSoundEnabled(prefs.sound)

  let hostPeerId = null // welcome をくれたピア＝host。以後 host とのみ通信する（スター型）
  let playerId = null
  let snapshot = null
  let peersSeen = 0
  let pressedKey = null // 押下済みの受付回を識別する（再開放で armedAt が変わると再度押せる）
  let joinTimer = null

  // --- DOM ---
  const statusDot = el('span', { class: 'dot wait' })
  const statusText = el('span', { class: 'status-text', text: '接続中' })
  const phaseEl = el('div', { class: 'phase-banner', text: '接続中…' })
  const questionEl = el('div', { class: 'question-text card', text: '' })

  // 早押しボタン: 台（base）とボタン（cap）の2層 + 状態ラベル
  const buzzerBase = el('img', { class: 'buzzer-base', alt: '', draggable: 'false' })
  const buzzerCap = el('img', { class: 'buzzer-cap', alt: '', draggable: 'false' })
  const buzzerLabel = el('span', { class: 'buzzer-label', text: '接続中…' })
  const buzzerRig = el('div', { class: 'buzzer-rig' }, [buzzerBase, buzzerCap, buzzerLabel])
  const buzzer = el('button', { class: 'buzzer' }, [buzzerRig])

  const rankEl = el('div', { class: 'stat', text: '順位 —' })
  const scoreEl = el('div', { class: 'stat', text: '得点 0' })
  const resultEl = el('div', { class: 'result-banner hidden', text: '' })

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

  const overlayTitle = el('h2', { text: '' })
  const overlayMessage = el('p', { text: '' })
  const overlayButtons = el('div', { class: 'btn-row' })
  const spinner = el('div', { class: 'spinner' })
  const overlay = el('div', { class: 'overlay' }, [spinner, overlayTitle, overlayMessage, overlayButtons])

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
      el('div', { class: 'me-row' }, [rankEl, scoreEl]),
      resultEl,
    ]),
    overlay,
  )
  applyBuzzerStyle(prefs.buttonStyle)

  showOverlay('接続しています…', `ルームコード: ${roomCode}`, [
    el('button', { class: 'btn', text: 'キャンセル', onclick: goTop }),
  ], { withSpinner: true })

  function setStatus(kind, label) {
    statusDot.className = `dot ${kind}`
    statusText.textContent = label
  }

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

  buzzer.addEventListener('pointerdown', (ev) => {
    const t = performance.now() // 押下時刻を最初に確定させる
    ev.preventDefault()
    unlockAudio()
    if (!canBuzz()) return
    pressedKey = pressKey()
    transport.send({ type: MSG.BUZZ, qid: snapshot.qid, t }, hostPeerId)
    navigator.vibrate?.(50)
    playBuzz()
    renderState()
  })
  buzzer.addEventListener('contextmenu', (ev) => ev.preventDefault())

  // --- 状態描画（host から配信されたスナップショットを描くだけ） ---

  function renderState() {
    if (snapshot === null) return
    phaseEl.textContent = PHASE_LABEL[snapshot.phase]
    questionEl.textContent = snapshot.questionText !== '' ? snapshot.questionText : '（問題文なし）'

    const me = snapshot.players.find((p) => p.playerId === playerId)
    scoreEl.textContent = `得点 ${me !== undefined ? me.score : 0}`

    const rankIndex = snapshot.order.findIndex((o) => o.playerId === playerId)
    if (rankIndex >= 0) {
      const deltaMs = snapshot.order[rankIndex].deltaMs
      rankEl.textContent = rankIndex === 0 ? '順位 1位' : `順位 ${rankIndex + 1}位 (+${deltaMs.toFixed(1)}ms)`
    } else {
      rankEl.textContent = '順位 —'
    }

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
        buzzerLabel.textContent = 'ロック中'
      }
    } else if (snapshot.phase === PHASE.QUESTION) {
      buzzerLabel.textContent = 'まだ押せません'
    } else {
      stateClasses.push('dim')
      buzzerLabel.textContent = '待機中'
    }
    applyBuzzerClasses()

    if (snapshot.result !== null) {
      if (snapshot.result.correct) {
        const winner = snapshot.players.find((p) => p.playerId === snapshot.result.playerId)
        resultEl.textContent =
          snapshot.result.playerId === playerId
            ? '正解！ +1点'
            : `${winner !== undefined ? winner.nick : '？'} さんが正解`
        resultEl.className = 'result-banner ok'
      } else {
        resultEl.textContent = '正解者なし'
        resultEl.className = 'result-banner ng'
      }
    } else {
      resultEl.className = 'result-banner hidden'
    }
  }

  // 前回スナップショットとの差分から効果音を鳴らす
  function notifyTransitions(prev, next) {
    // 回答権が自分に回ってきた
    if (next.phase === PHASE.LOCKED && next.activePlayerId === playerId && prev.activePlayerId !== playerId) {
      playYourTurn()
    }
    // 自分が誤答と判定された（除外に追加された）
    if (next.excluded.includes(playerId) && !prev.excluded.includes(playerId)) {
      playWrong()
    }
    // 判定結果が出た
    if (next.result !== null && prev.result === null) {
      if (next.result.correct) playCorrect()
      else playWrong()
    }
  }

  // --- 通信 ---

  function acceptWelcome(msg, peerId) {
    clearTimeout(joinTimer)
    hostPeerId = peerId
    playerId = msg.playerId
    hideOverlay()
    setStatus('on', msg.resumed ? '確立（得点引き継ぎ）' : '確立')
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

  window.addEventListener('beforeunload', () => transport.leave())
  transport.join(roomCode)
}
