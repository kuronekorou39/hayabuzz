import { playBuzz, playCorrect, playWrong, playYourTurn, setSoundEnabled, setSoundVolume, unlockAudio } from '../audio.js'
import { CONFIG } from '../config.js'
import { MASS_PHASE_LABEL, PHASE, PHASE_LABEL } from '../game/phases.js'
import { rankMark, scoreRank } from '../game/rank.js'
import { MSG, PROTO_VERSION, validateMessage } from '../net/protocol.js'
import { createTransport } from '../net/transport.js'
import { teamMeta, teamTotals } from '../game/teams.js'
import { diagText } from '../net/diag.js'
import { loadPrefs, savePrefs } from '../prefs.js'
import { backdropDismiss, el, popupOverlay } from '../util/dom.js'
import { randomCode } from '../util/random.js'
import { BUZZER_STYLES, getBuzzerStyle } from './buzzer-styles.js'
import { buzzerSprite, spriteFormatReady } from './sprites.js'
import { setLeaveGuard } from './leave-guard.js'
import { showToast } from './toast.js'

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
  setLeaveGuard(false) // 自分の意思で出るときは確認しない
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
  setSoundVolume(prefs.volume)

  let hostPeerId = null // welcome をくれたピア＝host。以後 host とのみ通信する（スター型）
  let playerId = null
  let snapshot = null
  let peersSeen = 0
  let pressedKey = null // 押下済みの受付回を識別する（再開放で armedAt が変わると再度押せる）
  let joinTimer = null

  // 結果や順位は常設せず、一時表示のトーストで伝える（実体は ui/toast.js）

  // --- DOM ---
  const statusDot = el('span', { class: 'dot wait' })
  const statusText = el('span', { class: 'status-text', text: '接続中' })
  const phaseEl = el('div', { class: 'phase-banner', text: '接続中…' })
  // 問題カード: Q番号バッジ + 本文（3行ぶんの高さ固定）
  const qBadge = el('span', { class: 'q-badge ghost', text: '' })
  const questionEl = el('div', { class: 'question-text question-body', text: '' })
  const questionCard = el('div', { class: 'card question-card' }, [
    el('div', { class: 'question-head' }, [qBadge]),
    questionEl,
  ])

  // 早押しボタン: 台（base）とボタン（cap）の2層 + 状態ラベル
  const buzzerBase = el('img', { class: 'buzzer-base', alt: '', draggable: 'false' })
  const buzzerCap = el('img', { class: 'buzzer-cap', alt: '', draggable: 'false' })
  const buzzerLabel = el('span', { class: 'buzzer-label', text: '接続中…' })
  const buzzerRig = el('div', { class: 'buzzer-rig' }, [buzzerBase, buzzerCap, buzzerLabel])
  const buzzer = el('button', { class: 'buzzer' }, [buzzerRig])

  // 一斉回答（○×・4択）の回答パネル。早押しボタンの代わりに表示する
  const answerPanel = el('div', { class: 'answer-panel hidden' })
  let selectedValue = null
  let answerQid = null
  let builtAnswerMode = null

  function sendAnswer(value) {
    if (snapshot === null || snapshot.phase !== PHASE.ARMED || hostPeerId === null) return
    unlockAudio()
    selectedValue = value
    answerQid = snapshot.qid
    transport.send({ type: MSG.ANSWER, qid: snapshot.qid, value }, hostPeerId)
    navigator.vibrate?.(30)
    renderState()
  }

  // 4択の選択肢テキスト（問題セットから出題された場合のみ配信される）
  function buildAnswerPanel(mode, choices = []) {
    const options =
      mode === 'ox'
        ? [{ value: 'o', label: '○', cls: 'answer-o' }, { value: 'x', label: '×', cls: 'answer-x' }]
        : ['1', '2', '3', '4'].map((n, i) => ({ value: n, label: n, text: choices[i] ?? '', cls: 'answer-choice' }))
    const hasText = options.some((option) => (option.text ?? '') !== '')
    answerPanel.className = `answer-panel ${mode === 'ox' ? 'grid-ox' : 'grid-choice4'}${hasText ? ' with-text' : ''}`
    answerPanel.replaceChildren(
      ...options.map((option) =>
        el('button', {
          class: `answer-btn ${option.cls}`,
          'data-value': option.value,
          onclick: () => sendAnswer(option.value),
        }, (option.text ?? '') !== ''
          ? [el('span', { class: 'answer-num', text: option.label }), el('span', { class: 'answer-text', text: option.text })]
          : [el('span', { class: 'answer-num', text: option.label })]),
      ),
    )
  }

  // 結果発表（最終ランキング）
  const finalTotals = el('div', { class: 'team-totals' })
  const finalRows = el('div', { class: 'board-rows' })
  const finalOverlay = el('div', { class: 'overlay final-overlay hidden' }, [
    el('div', { class: 'card board-card' }, [el('h2', { text: '結果発表' }), finalTotals, finalRows]),
  ])

  // 下部バー: 自分の所属チーム・得点の要約 + 得点表を開くボタン
  const myTeamChip = el('span', { class: 'team-chip hidden', text: '' })
  // 自分の要約: 名前・得点・順位を離して並べる（1つの文字列だと数字が3種類並んで読みづらい）
  const meNick = el('span', { class: 'me-nick', text: '' })
  const meScoreEl = el('span', { class: 'me-score', text: '—' })
  const meRankMain = el('span', { text: '' })
  const meRankSub = el('span', { class: 'me-sub', text: '' })
  const meSummary = el('span', { class: 'me-summary' }, [
    meNick,
    meScoreEl,
    el('span', { class: 'me-rank' }, [meRankMain, meRankSub]),
  ])
  const boardTotals = el('div', { class: 'team-totals' })
  const boardRows = el('div', { class: 'board-rows' })
  const boardOverlay = popupOverlay(
    'board-overlay',
    el('div', { class: 'card board-card' }, [el('h2', { text: '得点表' }), boardTotals, boardRows]),
  )
  const bottomBar = el('div', { class: 'bottom-bar' }, [
    el('span', { class: 'bottom-me' }, [myTeamChip, meSummary]),
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
      buzzerBase.src = buzzerSprite(style.base)
      buzzerCap.src = buzzerSprite(style.cap)
      buzzer.style.setProperty('--base-clip', style.baseClip)
      buzzer.style.setProperty('--cap-clip', style.capClip)
      buzzer.style.setProperty('--cap-w', style.capW)
      buzzer.style.setProperty('--cap-dx', style.capDx ?? '0%')
      buzzer.style.setProperty('--cap-dy', style.capDy ?? '0%')
      buzzer.style.setProperty('--glow', style.glow)
    }
    applyBuzzerClasses()
  }

  // スタイル選択: 見て選べるミニプレビューのグリッド
  const styleGrid = el('div', { class: 'style-grid' })

  function renderStyleGrid() {
    const currentId = getBuzzerStyle(prefs.buttonStyle).id
    styleGrid.replaceChildren(
      ...BUZZER_STYLES.map((style) => {
        let preview
        if (style.base === undefined) {
          preview = el('span', { class: 'swatch-rig swatch-simple', text: '押' })
        } else {
          preview = el('span', { class: 'swatch-rig' }, [
            el('img', { class: 'swatch-base', src: buzzerSprite(style.base), alt: '', draggable: 'false' }),
            el('img', { class: 'swatch-cap', src: buzzerSprite(style.cap), alt: '', draggable: 'false' }),
          ])
          preview.style.setProperty('--base-clip', style.baseClip)
          preview.style.setProperty('--cap-clip', style.capClip)
          preview.style.setProperty('--cap-w', style.capW)
          preview.style.setProperty('--cap-dx', style.capDx ?? '0%')
          preview.style.setProperty('--cap-dy', style.capDy ?? '0%')
        }
        return el('button', {
          class: style.id === currentId ? 'style-swatch selected' : 'style-swatch',
          'data-style': style.id,
          onclick: () => {
            prefs.buttonStyle = style.id
            savePrefs(prefs)
            applyBuzzerStyle(style.id)
            renderStyleGrid()
          },
        }, [
          preview,
          el('span', { class: 'swatch-label', text: style.label.split('（')[0] }),
        ])
      }),
    )
  }
  renderStyleGrid()
  spriteFormatReady.then(renderStyleGrid) // 形式判定後に正しい拡張子で描き直す

  // 効果音は音量スライダー。動かし終わりに一鳴らしして音量を確かめられる
  const volumeSlider = el('input', { type: 'range', min: '0', max: '100', step: '1' })
  volumeSlider.value = String(Math.round(prefs.volume * 100))
  volumeSlider.addEventListener('input', () => {
    prefs.volume = Number(volumeSlider.value) / 100
    prefs.sound = true
    setSoundVolume(prefs.volume)
    setSoundEnabled(true)
  })
  volumeSlider.addEventListener('change', () => {
    savePrefs(prefs)
    unlockAudio()
    playYourTurn()
  })

  // 接続診断: 接続ステータスが赤のときだけトップバーにヘルプとして出す
  const diagViewText = el('div', { class: 'diag-log' })
  const diagOverlay = popupOverlay(
    'diag-overlay',
    el('div', { class: 'card rules-card' }, [el('h2', { text: '接続診断' }), diagViewText]),
  )
  const helpBtn = el('button', { class: 'btn btn-small hidden', text: 'ヘルプ', onclick: () => {
    diagViewText.textContent = diagText(40)
    diagOverlay.classList.remove('hidden')
  } })

  const settingsOverlay = popupOverlay(
    'settings-overlay',
    el('div', { class: 'card rules-card' }, [
      el('h2', { text: '設定' }),
      el('div', { class: 'settings-row settings-col' }, [el('span', { text: 'ボタンの見た目' }), styleGrid]),
      el('div', { class: 'settings-row' }, [el('span', { text: '効果音' }), volumeSlider]),
    ]),
  )
  const settingsBtn = el('button', {
    class: 'icon-btn',
    text: '⚙︎',
    'aria-label': '設定',
    onclick: () => settingsOverlay.classList.remove('hidden'),
  })

  // --- 接続オーバーレイ（接続中/エラー/部屋終了の全画面表示） ---
  const overlayTitle = el('h2', { text: '' })
  const overlayMessage = el('p', { text: '' })
  const overlayDiag = el('div', { class: 'diag-log hidden' })
  const overlayButtons = el('div', { class: 'btn-row' })
  const spinner = el('div', { class: 'spinner' })
  const overlay = el('div', { class: 'overlay conn-overlay' }, [
    spinner,
    overlayTitle,
    overlayMessage,
    overlayDiag,
    overlayButtons,
  ])

  function showOverlay(title, message, buttons, { withSpinner = false, withDiag = false } = {}) {
    overlayTitle.textContent = title
    overlayMessage.textContent = message
    overlayDiag.textContent = withDiag ? `診断情報:\n${diagText()}` : ''
    overlayDiag.classList.toggle('hidden', !withDiag)
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
        el('div', { class: 'status' }, [statusDot, statusText, helpBtn, settingsBtn]),
      ]),
      questionCard,
      buzzer,
      answerPanel,
      phaseEl, // ステータスはボタンの下（問題文の長さでボタンが動かない配置）
      bottomBar,
    ]),
    overlay,
    settingsOverlay,
    boardOverlay,
    finalOverlay,
    diagOverlay,
  )
  // ポップアップは範囲外タップでも閉じる（接続系と結果発表は除く）
  backdropDismiss(settingsOverlay, boardOverlay, diagOverlay)
  applyBuzzerStyle(prefs.buttonStyle)
  // WebP 非対応ブラウザの判定が済んだら正しい形式で当て直す
  spriteFormatReady.then(() => applyBuzzerStyle(prefs.buttonStyle))

  showOverlay('接続しています…', `ルームコード: ${roomCode}`, [
    el('button', { class: 'btn', text: 'キャンセル', onclick: goTop }),
  ], { withSpinner: true })

  function setStatus(kind, label) {
    statusDot.className = `dot ${kind}`
    statusText.textContent = label
    helpBtn.classList.toggle('hidden', kind !== 'off') // 赤（切断・未接続）のときだけヘルプを出す
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

  // --- 問題文の表示（順次表示ルールでは読み上げアニメーションつき） ---
  let revealTimer = null
  let armedSeenAt = 0 // ARMED 状態を受信したローカル時刻（読み上げ経過の基準）
  let lastArmedKey = null

  function stopRevealAnim() {
    if (revealTimer !== null) {
      clearInterval(revealTimer)
      revealTimer = null
    }
  }

  function serialQuestionText(chars) {
    const text = snapshot.questionText
    const count = Math.min(text.length, Math.floor(chars))
    return count <= 0 ? '（早押し開始で問題文が読み上げられます）' : text.slice(0, count)
  }

  // 問題文エリアは3行ぶんの高さ固定。収まらなければ文字を1段階縮小し、
  // それでも超える分はスクロールで見る。stickToEnd は読み上げ中に
  // 最新の文字が見えるよう末尾へ追従させる
  function setQuestionText(text, stickToEnd = false) {
    if (questionEl.textContent === text) return
    questionEl.textContent = text
    questionEl.classList.remove('question-small')
    if (questionEl.scrollHeight > questionEl.clientHeight + 2) questionEl.classList.add('question-small')
    questionEl.scrollTop = stickToEnd ? questionEl.scrollHeight : 0
  }

  function renderRevealFrame() {
    if (snapshot === null || snapshot.phase !== PHASE.ARMED) {
      stopRevealAnim()
      return
    }
    const elapsedSec = (performance.now() - armedSeenAt) / 1000
    const chars = snapshot.revealBase + snapshot.rules.revealCps * elapsedSec
    setQuestionText(serialQuestionText(chars), true)
    if (chars >= snapshot.questionText.length) stopRevealAnim()
  }

  function renderQuestionText() {
    if (snapshot.phase === PHASE.WAITING || snapshot.phase === PHASE.FINAL) {
      // 状態はフェーズ表示が伝えるので、問題カードは空にして画面を静かに保つ
      stopRevealAnim()
      setQuestionText('')
      return
    }
    if (snapshot.questionText === '') {
      stopRevealAnim()
      setQuestionText('（口頭で出題）')
      return
    }
    if (snapshot.rules.reveal !== 'serial') {
      stopRevealAnim()
      setQuestionText(snapshot.questionText)
      return
    }
    if (snapshot.phase === PHASE.ARMED) {
      const key = `${snapshot.qid}:${snapshot.armedAt}`
      if (lastArmedKey !== key) {
        lastArmedKey = key
        armedSeenAt = performance.now()
      }
      renderRevealFrame()
      if (revealTimer === null) revealTimer = setInterval(renderRevealFrame, 80)
    } else {
      stopRevealAnim()
      setQuestionText(serialQuestionText(snapshot.revealBase), true)
    }
  }

  // 得点順の順位・順位マーク（判定ロジックは game/rank.js に共通化）
  const scoreRankOf = (p) => scoreRank(snapshot.players, p)
  const rankMarkOf = (p) => (scoresHidden() ? '' : rankMark(snapshot.players, p, snapshot.rules.rankBadges))

  // 「得点を隠す」ルール。結果発表では公開する（隠したまま終わっては盛り上がらない）
  const scoresHidden = () => snapshot.rules.hideScores && snapshot.phase !== PHASE.FINAL
  const scoreText = (score) => (scoresHidden() ? '?点' : `${score}点`)
  // 得点を隠す設定では、通知からも点数を伏せる
  const pointsText = (shown, hidden) => (scoresHidden() ? hidden : shown)

  // --- 状態描画（host から配信されたスナップショットを描くだけ） ---
  let lastScore = null

  function renderState() {
    if (snapshot === null) return
    const mass = snapshot.rules.answerMode !== 'buzzer'
    // 判定結果では（答えが設定されていれば）フェーズ名の代わりに答えを表示する
    phaseEl.textContent =
      snapshot.phase === PHASE.RESULT && snapshot.answerText !== null
        ? `答え：${snapshot.answerText}`
        : ((mass ? MASS_PHASE_LABEL[snapshot.phase] : undefined) ?? PHASE_LABEL[snapshot.phase])
    phaseEl.className = `phase-banner phase-${snapshot.phase}`
    // Q番号バッジ（出題前後は visibility だけ消して高さを保つ）
    const badgeVisible = snapshot.phase !== PHASE.WAITING && snapshot.phase !== PHASE.FINAL
    qBadge.textContent = badgeVisible ? `Q${snapshot.qid}` : ''
    qBadge.classList.toggle('ghost', !badgeVisible)
    // 接続ランプの横には文字の代わりに通信の往復時間を出す（緑のときだけ）
    if (statusDot.classList.contains('on')) {
      const meRtt = snapshot.players.find((p) => p.playerId === playerId)?.rttMs
      statusText.textContent = meRtt == null ? '' : `${meRtt}ms`
    }
    // 新しい問題が来たら出現アニメーションを付ける
    if (questionEl.dataset.qid !== String(snapshot.qid)) {
      questionEl.dataset.qid = String(snapshot.qid)
      questionEl.classList.remove('appear')
      void questionEl.offsetWidth // リフローでアニメーションを再始動させる
      questionEl.classList.add('appear')
    }
    renderQuestionText()

    // 一斉回答モードでは早押しボタンの代わりに回答パネルを表示する
    buzzer.style.display = mass ? 'none' : ''
    if (mass) {
      // 選択肢は問題ごとに変わるため、形式か選択肢が変わったら作り直す
      const panelKey = `${snapshot.rules.answerMode}:${snapshot.choices.join(' ')}`
      if (builtAnswerMode !== panelKey) {
        builtAnswerMode = panelKey
        buildAnswerPanel(snapshot.rules.answerMode, snapshot.choices)
        selectedValue = null
      }
      answerPanel.classList.remove('hidden')
      if (answerQid !== snapshot.qid) selectedValue = null // 新しい問題で選択をリセット
      const canAnswer = snapshot.phase === PHASE.ARMED
      // 締切後は host 配信の回答が正、受付中はローカルの選択を表示
      const myAnswer =
        snapshot.revealedAnswers?.find((a) => a.playerId === playerId)?.value ??
        (answerQid === snapshot.qid ? selectedValue : null)
      answerPanel.classList.toggle('dim', !canAnswer && snapshot.correctValue === null)
      for (const button of answerPanel.children) {
        const value = button.dataset.value
        button.disabled = !canAnswer
        button.classList.toggle('selected', value === myAnswer)
        button.classList.toggle('correct', snapshot.correctValue !== null && value === snapshot.correctValue)
        button.classList.toggle(
          'wrong-pick',
          snapshot.correctValue !== null && value === myAnswer && value !== snapshot.correctValue,
        )
      }
    } else {
      answerPanel.classList.add('hidden')
    }

    // 結果発表（最終ランキング）
    if (snapshot.phase === PHASE.FINAL) {
      if (snapshot.rules.teams > 0) {
        finalTotals.replaceChildren(
          ...teamTotals(snapshot.players, snapshot.rules.teams)
            .sort((a, b) => b.score - a.score)
            .map((t) => {
              const meta = teamMeta(t.team)
              return el('span', { class: `team-chip ${meta.cls}`, text: `${meta.label} ${t.score}点` })
            }),
        )
      } else {
        finalTotals.replaceChildren()
      }
      const ranking = [...snapshot.players].sort((a, b) => b.score - a.score)
      finalRows.replaceChildren(
        ...ranking.map((p) => {
          const meta = snapshot.rules.teams > 0 ? teamMeta(p.team) : null
          const rank = scoreRankOf(p) // 同点は同順位
          const mark = rankMarkOf(p)
          return el('div', { class: p.playerId === playerId ? 'board-row me' : 'board-row' }, [
            el('span', { class: rank === 1 ? 'final-rank final-top' : 'final-rank', text: `${rank}位` }),
            ...(mark !== '' ? [el('span', { class: 'rank-mark', text: mark })] : []),
            ...(meta !== null ? [el('span', { class: `team-chip ${meta.cls}`, text: meta.label })] : []),
            el('span', { class: 'board-nick', text: p.nick }),
            ...(p.playerId === playerId ? [el('span', { class: 'you-chip', text: 'YOU' })] : []),
            el('span', { class: 'board-score', text: `${p.score}点` }),
          ])
        }),
      )
      finalOverlay.classList.remove('hidden')
    } else {
      finalOverlay.classList.add('hidden')
    }

    const excluded = snapshot.excluded.includes(playerId)
    stateClasses = []
    if (excluded) {
      stateClasses.push('dim')
      buzzerLabel.textContent = '誤答のため待機'
    } else if (snapshot.phase === PHASE.FINAL) {
      stateClasses.push('dim')
      buzzerLabel.textContent = '結果発表'
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
      // 待機中（ゲームの状態はフェーズ表示が伝えるので、ボタンには押せる/押せないだけ書く）
      stateClasses.push('dim')
      buzzerLabel.textContent = 'まだ押せません'
    }
    applyBuzzerClasses()

    // 自分の得点の要約（得点順の順位）。得点が変わったらポップさせる
    const me = snapshot.players.find((p) => p.playerId === playerId)
    if (me !== undefined) {
      meNick.textContent = me.nick
      meScoreEl.textContent = scoreText(me.score)
      meRankMain.textContent = scoresHidden() ? '' : `${scoreRankOf(me)}位`
      meRankSub.textContent = scoresHidden() ? `${snapshot.players.length}人` : `/${snapshot.players.length}人`
      if (lastScore !== null && me.score !== lastScore) {
        meScoreEl.classList.remove('pop')
        void meScoreEl.offsetWidth
        meScoreEl.classList.add('pop')
      }
      lastScore = me.score
      // 所属チームの表示
      const myMeta = snapshot.rules.teams > 0 ? teamMeta(me.team) : null
      if (myMeta !== null) {
        myTeamChip.textContent = myMeta.label
        myTeamChip.className = `team-chip ${myMeta.cls}`
      } else {
        myTeamChip.className = 'team-chip hidden'
      }
    } else {
      meNick.textContent = ''
      meScoreEl.textContent = '—'
      meRankMain.textContent = ''
      meRankSub.textContent = ''
    }

    // 得点表（オーバーレイの中身。開いたときに最新になるよう常に更新しておく）
    if (snapshot.rules.teams > 0) {
      boardTotals.replaceChildren(
        ...teamTotals(snapshot.players, snapshot.rules.teams).map((t) => {
          const meta = teamMeta(t.team)
          return el('span', { class: `team-chip ${meta.cls}`, text: `${meta.label} ${scoreText(t.score)}` })
        }),
      )
    } else {
      boardTotals.replaceChildren()
    }
    // 得点を隠す設定では並び順からも順位が読めてしまうため、参加順のまま並べる
    const board = scoresHidden() ? [...snapshot.players] : [...snapshot.players].sort((a, b) => b.score - a.score)
    boardRows.replaceChildren(
      ...board.map((p) => {
        const meta = snapshot.rules.teams > 0 ? teamMeta(p.team) : null
        const mark = rankMarkOf(p)
        return el('div', { class: p.playerId === playerId ? 'board-row me' : 'board-row' }, [
          el('span', { class: p.connected ? 'dot on' : 'dot off' }),
          ...(mark !== '' ? [el('span', { class: 'rank-mark', text: mark })] : []),
          ...(meta !== null ? [el('span', { class: `team-chip ${meta.cls}`, text: meta.label })] : []),
          el('span', { class: 'board-nick', text: p.nick }),
          ...(p.playerId === playerId ? [el('span', { class: 'you-chip', text: 'YOU' })] : []),
          ...(!scoresHidden() && snapshot.rules.winScore > 0 && p.score >= snapshot.rules.winScore
            ? [el('span', { class: 'badge win', text: '勝ち抜け' })]
            : []),
          ...(p.handicapMs > 0
            ? [el('span', { class: 'handicap-note', text: `ハンデ+${p.handicapMs}ms` })]
            : []),
          el('span', { class: 'board-score', text: scoreText(p.score) }),
        ])
      }),
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
    // 勝ち抜けラインに到達した
    if (next.rules.winScore > 0) {
      const prevMe = prev.players.find((p) => p.playerId === playerId)
      const nextMe = next.players.find((p) => p.playerId === playerId)
      if (
        prevMe !== undefined &&
        nextMe !== undefined &&
        prevMe.score < next.rules.winScore &&
        nextMe.score >= next.rules.winScore
      ) {
        showToast('勝ち抜け！', 'ok')
      }
    }
    // 判定結果が出た
    if (next.result !== null && prev.result === null) {
      if (next.result.correct) {
        playCorrect()
        const winner = next.players.find((p) => p.playerId === next.result.playerId)
        showToast(
          next.result.playerId === playerId
            ? pointsText(`正解！ +${next.rules.correctPoints}点`, '正解！')
            : `${winner !== undefined ? winner.nick : '？'} さんが正解`,
          'ok',
        )
      } else {
        playWrong()
        showToast('正解者なし', 'ng')
      }
    }
    // 一斉回答の正答が発表された
    if (next.correctValue !== null && prev.correctValue === null) {
      const mine = next.revealedAnswers?.find((a) => a.playerId === playerId)?.value
      if (mine === undefined) {
        showToast('未回答', '')
      } else if (mine === next.correctValue) {
        playCorrect()
        showToast(pointsText(`正解！ +${next.rules.correctPoints}点`, '正解！'), 'ok')
      } else {
        playWrong()
        showToast('不正解…', 'ng')
      }
    }
  }

  // --- 通信 ---

  // host からの応答の監視。DataChannel は信頼配送なので、定期同期（10秒ごと）が
  // 一定時間届かなければ回線が死んでいるとみなせる（機内モード等では ICE の
  // 切断検出が遅れる・発火しないことがあるため、アプリ層でも監視する）
  let lastHostMsgAt = performance.now()
  let connLost = false
  let roomEnded = false

  function showConnLost() {
    connLost = true
    setStatus('off', '応答なし')
    showOverlay('接続が切れました', '出題者からの応答がありません。通信環境を確認してください。回線が復帰すれば自動で再開します。戻らない場合は再接続してください。', [
      el('button', { class: 'btn btn-primary', text: '再接続する', onclick: () => {
        setLeaveGuard(false)
        location.reload()
      } }),
      el('button', { class: 'btn', text: 'トップへ戻る', onclick: goTop }),
    ], { withSpinner: true, withDiag: true })
  }

  function noteHostAlive() {
    lastHostMsgAt = performance.now()
    if (connLost && !roomEnded) {
      connLost = false
      hideOverlay()
      setStatus('on', '')
      showToast('接続が復帰しました', 'ok')
    }
  }

  setInterval(() => {
    if (hostPeerId === null || roomEnded || connLost) return
    if (performance.now() - lastHostMsgAt < CONFIG.hostSilenceTimeoutMs) return
    showConnLost()
  }, 3000)
  // タブがスリープしていた間の無応答は誤検出なので、復帰時に起点を取り直す
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) lastHostMsgAt = performance.now()
  })

  function acceptWelcome(msg, peerId) {
    clearTimeout(joinTimer)
    hostPeerId = peerId
    playerId = msg.playerId
    lastHostMsgAt = performance.now()
    hideOverlay()
    setLeaveGuard(true) // 接続中の誤リロードで部屋から出ないよう確認を挟む
    setStatus('on', '') // 文字は出さない（緑ランプ + state 受信後は ping 表示）
    if (msg.resumed) showToast('得点を引き継ぎました', 'ok')
  }

  function showRoomClosed() {
    // 自分の回線が落ちているだけなら部屋はまだ生きている可能性が高い
    if (navigator.onLine === false) {
      showConnLost()
      return
    }
    roomEnded = true
    setLeaveGuard(false) // 部屋が終了した後のリロードは自由
    setStatus('off', '切断')
    showOverlay('部屋が終了しました', '出題者との接続が切れました。ホストなしでは続行できません。', [
      el('button', { class: 'btn btn-primary', text: 'トップへ戻る', onclick: goTop }),
    ], { withDiag: true })
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
    noteHostAlive()
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

  // 旧 Safari（iOS 12 等）はマイク許可がないと LAN 内の接続候補（host 候補）を
  // 出さないため、同一 Wi-Fi でも直結できない。許可を取って接続をやり直す
  async function retryWithCompat() {
    showOverlay('接続しています…', `ルームコード: ${roomCode}`, [
      el('button', { class: 'btn', text: 'キャンセル', onclick: goTop }),
    ], { withSpinner: true })
    setStatus('wait', '接続中')
    try {
      await transport.enableLegacyCompat()
    } catch {
      // 拒否された場合はタイムアウト後に診断つきで再表示される
    }
    startJoinTimer()
  }

  // 対称NAT等で確立できない場合に無限にスピナーを回さない
  function startJoinTimer() {
    clearTimeout(joinTimer)
    joinTimer = setTimeout(() => {
      if (hostPeerId !== null) return
      setStatus('off', '未接続')
      const buttons = []
      let message
      const compatAvailable = typeof navigator.mediaDevices?.getUserMedia === 'function'
      if (transport.hasHostCandidates() === false && compatAvailable) {
        // 旧 Safari はマイク許可がないと LAN 内の接続候補を出さない
        message =
          'お使いの端末（古い Safari 等）ではマイク使用を一度許可すると接続できる場合があります。音声は使いません。'
        buttons.push(el('button', { class: 'btn btn-primary', text: 'マイク許可で再試行', onclick: retryWithCompat }))
      } else if (transport.hasHostCandidates() === false) {
        // メディア API 自体が無効でマイク許可の手が使えない状態
        message =
          'この端末ではマイクAPIが無効のため接続候補を増やせません。プライベートブラウズをオフにし、iOSの「設定 → Safari → カメラとマイクのアクセス」を許可してから、通常のタブで開き直してください。'
      } else if (peersSeen === 0) {
        message =
          'この回線では P2P 接続を確立できない可能性があります（対称NAT等）。別の回線（モバイル回線など）でお試しください。'
      } else {
        message =
          'ホストが見つかりませんでした。ルームコードが正しいか、出題者の画面が開いているか確認してください。'
      }
      buttons.push(el('button', { class: 'btn', text: '再試行', onclick: () => location.reload() }))
      buttons.push(el('button', { class: 'btn', text: 'トップへ戻る', onclick: goTop }))
      showOverlay('接続できませんでした', message, buttons, { withDiag: true })
    }, CONFIG.joinTimeoutMs)
  }
  startJoinTimer()

  window.addEventListener('pagehide', () => transport.leave())
  transport.join(roomCode).catch(() => {}) // 失敗内容は診断ログに記録済み
}
