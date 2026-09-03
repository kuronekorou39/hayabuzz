import QRCode from 'qrcode'
import { playCorrect, playLock, playWrong, setSoundEnabled, setSoundVolume, unlockAudio } from '../audio.js'
import { CONFIG } from '../config.js'
import { HostGame } from '../game/host-game.js'
import { PHASE } from '../game/phases.js'
import { rankMark } from '../game/rank.js'
import {
  loadBank,
  markAsked,
  recordOutcome as recordBankOutcome,
  saveBank,
} from '../game/question-bank.js'
import { clearHostRoom, saveHostRoom } from '../game/room-store.js'
import { teamMeta, teamTotals } from '../game/teams.js'
import { diagText } from '../net/diag.js'
import { MSG, validateMessage } from '../net/protocol.js'
import { createTransport } from '../net/transport.js'
import { loadPrefs, savePrefs } from '../prefs.js'
import { backdropDismiss, closeX, el, popupOverlay } from '../util/dom.js'
import { randomCode } from '../util/random.js'
import { answerLabel, createAnswerFields, createBankPanel } from './question-bank-ui.js'
import { showToast } from './toast.js'

// saved: この端末に保存しておいた部屋（room-store.js）。渡されたときはその部屋に復帰する
export function mountHost(app, { saved = null } = {}) {
  unlockAudio() // トップ画面のクリック（ユーザー操作）を起点に AudioContext を有効化
  const prefs = loadPrefs()
  setSoundEnabled(prefs.sound)
  setSoundVolume(prefs.volume)
  // 問題集等のブラウザ保存が自動削除されにくいよう永続化を要求（対応ブラウザのみ）
  navigator.storage?.persist?.().catch(() => {})

  const bankItems = loadBank()
  let currentBankId = null // いま出題中の問題集の問題（答え・メモの手元表示と履歴記録に使う）
  let outcomeRecorded = false

  const game = new HostGame({
    send: (msg, peerId) => transport.send(msg, peerId),
    onChange: render,
    onPersist: persist,
  })
  const resuming = saved !== null
  if (resuming) {
    game.restore(saved.game)
    currentBankId = saved.currentBankId ?? null
    outcomeRecorded = saved.outcomeRecorded === true
  }
  const roomCode = resuming ? saved.roomCode : randomCode(CONFIG.roomCodeLen)
  const joinUrl = `${location.origin}${location.pathname}${location.search}#/join/${roomCode}`
  const transport = createTransport({ role: 'host' })
  // リロードしてもこの部屋に戻れるよう URL に部屋を残す（main.js が保存と突き合わせて復帰する）
  history.replaceState(null, '', `#/host/${roomCode}`)

  // 進行状態をこの端末に保存する。出題者がリロード等で離れても、トップ画面や URL から
  // 同じ部屋に復帰できる（回答者は待っていれば自動でつながり直す）
  function persist() {
    if (closing) return // 閉じた部屋を保存し直さない（閉じる直前の切断通知などで呼ばれうる）
    saveHostRoom({ roomCode, savedAt: Date.now(), game: game.serialize(), currentBankId, outcomeRecorded })
  }

  transport.onMessage((raw, peerId) => {
    if (!validateMessage(raw)) return // スキーマ検証に落ちたメッセージは破棄
    game.handleMessage(raw, peerId)
  })
  transport.onPeerLeave((peerId) => game.handlePeerLeave(peerId))
  // host が消えると回答者は待たされるため、参加者がいる間は誤リロード/誤クローズに確認を挟む
  // （復帰はできるが、つなぎ直しに数秒かかる）。部屋を閉じてトップへ戻るときは確認しない
  let closing = false
  window.addEventListener('beforeunload', (ev) => {
    const hasPlayers = [...game.players.values()].some((p) => p.connected)
    if (hasPlayers && !closing) {
      ev.preventDefault()
      ev.returnValue = ''
    }
  })
  window.addEventListener('pagehide', () => {
    game.destroy()
    transport.leave()
  })

  // --- 接続状態（部屋を公開中であることを緑ランプで示す。人数は参加者シートの取っ手に出る） ---
  const statusDot = el('span', { class: 'dot on' })

  function topbar(extra = []) {
    return el('div', { class: 'topbar' }, [
      el('div', {}, [
        el('span', { class: 'brand', text: 'Hayabuzz' }),
        el('span', { class: 'role', text: '出題者' }),
      ]),
      el('div', { class: 'status' }, [statusDot, ...extra]),
    ])
  }

  // --- 共有カード（部屋を作った直後に自動で開き、以後は「共有」から開く） ---
  const urlInput = el('input', { class: 'input url-input', type: 'text', readonly: true, value: joinUrl })
  const copyBtn = el('button', { class: 'btn btn-small', text: 'コピー', onclick: copyUrl })
  const qrCanvas = el('canvas', { class: 'qr' })
  const shareCard = el('div', { class: 'card share-card' }, [
    el('h2', { text: 'ルームコード' }),
    el('div', { class: 'room-code', text: roomCode }),
    el('div', { class: 'url-row' }, [urlInput, copyBtn]),
    el('div', { class: 'qr-wrap' }, [qrCanvas]),
    // 意味のかたまりごとに分けて、「参加／できます」のような中途半端な位置で折り返さないようにする
    el('p', { class: 'share-note' }, [
      el('span', { text: '回答者はQRコードを読み取るか、' }),
      el('span', { text: 'URLを開くと参加できます' }),
    ]),
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

  // --- 参加者・得点（画面下に隠せるシート。閉じていても取っ手に要約が出る） ---
  const scoreRows = el('div', { class: 'score-rows' })
  const scorePlaceholder = el('p', { class: 'placeholder', text: 'まだ参加者がいません' })
  const teamTotalsRow = el('div', { class: 'team-totals' })
  const sheetSummary = el('span', { class: 'sheet-summary', text: '参加者 0人' })
  const sheetBody = el('div', { class: 'sheet-body' }, [scorePlaceholder, scoreRows])
  const sheetHandle = el('button', { class: 'sheet-handle', 'aria-expanded': 'false' }, [
    el('span', { class: 'sheet-grip' }),
    el('span', { class: 'sheet-head' }, [sheetSummary, teamTotalsRow, el('span', { class: 'sheet-caret', text: '▲' })]),
  ])
  const scoreSheet = el('div', { class: 'score-sheet' }, [sheetHandle, sheetBody])

  function setSheetOpen(open) {
    scoreSheet.classList.toggle('open', open)
    sheetHandle.setAttribute('aria-expanded', String(open))
  }
  sheetHandle.addEventListener('click', () => setSheetOpen(!scoreSheet.classList.contains('open')))
  // 開いたままだと出題の操作が隠れてしまうため、シートの外をタップしたら閉じる。
  // シート内のクリックはここで止める（得点操作で一覧が作り直されると、クリック元の要素が
  // DOM から外れて「外側のクリック」と誤判定されてしまうため、contains では判定しない）
  scoreSheet.addEventListener('click', (ev) => ev.stopPropagation())
  document.addEventListener('click', () => setSheetOpen(false))

  // --- 進行画面の部品 ---
  const questionInput = el('textarea', {
    class: 'input question-input',
    rows: '3',
    maxlength: CONFIG.questionMaxLen,
    placeholder: '問題文（空のまま口頭で読み上げてもOK）',
  })
  // 答え・選択肢の入力（回答形式に合わせて中身が変わる）
  const askFields = createAnswerFields('ask')

  const showBtn = el('button', { class: 'btn btn-primary', text: '全員に出題', onclick: () => {
    const type = game.rules.answerMode
    const { raw, choices } = askFields.read(type)
    // 問題集から読み込んだ問題なら、実際に出したこの時点で出題履歴を積む
    if (currentBankId !== null) {
      outcomeRecorded = false
      markAsked(bankItems, currentBankId, Date.now())
      saveBank(bankItems)
    }
    game.showQuestion({
      text: questionInput.value,
      answer: answerLabel(type, raw, choices),
      choices,
      plannedCorrect: type === 'buzzer' ? null : raw,
    })
  } })
  // 問題文を手で書き換えたら、問題集との紐付けを外す（別の問題になったとみなす）
  questionInput.addEventListener('input', () => {
    currentBankId = null
  })
  // 誤って表示したときの取り消し（出題前に戻して問題文を編集できるようにする）
  const cancelBtn = el('button', { class: 'btn', text: '取り消し', onclick: () => game.cancelQuestion() })
  const armBtn = el('button', { class: 'btn btn-arm', text: '早押し開始', onclick: () => game.arm() })
  const stopBtn = el('button', { class: 'btn', text: '受付停止', onclick: () => game.stop() })
  const closeAnswersBtn = el('button', { class: 'btn', text: '締め切り', onclick: () => game.closeAnswers() })

  const hostQBadge = el('span', { class: 'q-badge ghost', text: '' })

  // --- 進行のステップ表示（初見でも次に何をすればよいか分かるように） ---
  const STEPS = ['問題を用意', '全員に出題', '早押し受付', '判定']
  const MASS_STEPS = ['問題を用意', '全員に出題', '回答を受付', '正解を発表']
  const stepEls = STEPS.map((_, i) =>
    el('span', { class: 'step', 'data-step': String(i) }, [
      el('span', { class: 'step-num', text: String(i + 1) }),
      el('span', { class: 'step-label', text: '' }),
    ]),
  )
  const stepBar = el('div', { class: 'step-bar' }, stepEls)

  // いまどのステップにいるか（0始まり）
  function currentStep() {
    if (game.phase === PHASE.QUESTION) return 1
    if (game.phase === PHASE.ARMED) return 2
    if (game.phase === PHASE.LOCKED) return 3
    return 0 // 出題前・判定後・結果発表中は「次の問題を用意する」段階
  }

  function renderSteps() {
    const mass = game.isMassAnswerMode
    const labels = mass ? MASS_STEPS : STEPS
    const active = currentStep()
    stepEls.forEach((node, i) => {
      node.querySelector('.step-label').textContent = labels[i]
      node.className = `step${i === active ? ' active' : ''}${i < active ? ' done' : ''}`
    })
  }
  const currentQuestionEl = el('div', { class: 'question-text question-clamp', text: 'まだ問題がありません' })
  const answerLine = el('p', { class: 'answer-note hidden', text: '' }) // 答え・メモ（出題者の手元のみ）
  const orderList = el('ol', { class: 'order-list' })
  // 時刻同期の pong ごとに再描画が走るため、毎回すべての行に出現アニメを
  // 付けると一覧全体がチカチカする。新しく現れた行だけに付ける
  let shownRowIds = new Set()
  const orderRowClass = (id) => (shownRowIds.has(id) ? 'order-row' : 'order-row enter')
  const orderPlaceholder = el('p', { class: 'placeholder', text: 'まだ誰も押していません' })
  const resultLine = el('p', { class: 'result-line hidden', text: '' })
  // 問題集の問題の判定結果（正解者・誤答者）を問題集の履歴に書き込む
  function recordOutcome() {
    if (outcomeRecorded || currentBankId === null) return
    if (game.phase !== PHASE.RESULT) return
    const last = game.askedLog[game.askedLog.length - 1]
    const entry = last !== undefined && last.qid === game.qid ? last : null
    if (entry === null || !entry.decided) return
    const winner = entry.winners.length > 0 ? entry.winners.join('、').slice(0, 30) : null
    recordBankOutcome(bankItems, currentBankId, winner, [...entry.wrongs])
    saveBank(bankItems)
    outcomeRecorded = true
    persist() // 復帰後に同じ結果を二重に記録しないよう、記録済みであることも保存する
  }

  const correctBtn = el('button', { class: 'btn btn-ok', text: '正解', onclick: () => {
    playCorrect()
    game.judgeCorrect()
    recordOutcome()
  } })
  // 「誤答」= 誤答にして次に押した人へ回す（早押しの基本の流れ）。
  // 別の進め方（全員に再開放・他チームへ）は次の行に置く
  const wrongNextBtn = el('button', { class: 'btn btn-ng', text: '誤答', onclick: () => {
    playWrong()
    game.judgeWrongNext()
    recordOutcome() // 次点がおらず正解者なしで決着した場合の記録
  } })
  const wrongOpenBtn = el('button', { class: 'btn btn-ng btn-small', text: '全員に再開放', onclick: () => {
    playWrong()
    game.judgeWrongReopen()
  } })
  const wrongTeamBtn = el('button', { class: 'btn btn-ng btn-small', text: '他チームに開放', onclick: () => {
    playWrong()
    game.judgeWrongOpenOtherTeams()
  } })

  // 一斉回答モードの回答状況と正答宣言
  const answersLine = el('p', { class: 'placeholder answers-line', text: '' })
  const declareRow = el('div', { class: 'btn-row' })

  function buildDeclareButtons() {
    // 正解が事前に分かっていれば（問題集からの出題・答えを入力した出題）ワンタップで発表できる
    if (game.plannedCorrect !== null) {
      const label = game.answerText !== '' ? game.answerText : answerValueLabel(game.plannedCorrect)
      declareRow.replaceChildren(
        el('button', { class: 'btn btn-ok', text: `正解を発表（${label}）`, onclick: () => {
          playCorrect()
          game.declareCorrect(game.plannedCorrect)
          recordOutcome()
        } }),
      )
      return
    }
    const options =
      game.rules.answerMode === 'ox'
        ? [{ value: 'o', label: '正解は○' }, { value: 'x', label: '正解は×' }]
        : ['1', '2', '3', '4'].map((n) => ({ value: n, label: `正解は${n}` }))
    declareRow.replaceChildren(
      ...options.map((option) =>
        el('button', { class: 'btn btn-ok', text: option.label, onclick: () => {
          playCorrect()
          game.declareCorrect(option.value)
          recordOutcome() // 問題集からの出題なら結果を問題集の履歴にも残す
        } }),
      ),
    )
  }

  const finishBtn = el('button', { class: 'btn btn-small', text: '結果発表', onclick: () => {
    if (game.phase === PHASE.FINAL) game.resumeGame()
    else game.finishGame()
  } })
  const resetScoresBtn = el('button', { class: 'btn btn-ng btn-small', text: '得点リセット', onclick: () => game.resetScores() })

  // このセッションの出題履歴（問題・答え・正解者・誤答者）
  const historyRows = el('div', { class: 'history-rows' })
  const historyPlaceholder = el('p', { class: 'placeholder', text: 'まだ出題していません' })
  const historyOverlay = popupOverlay(
    'history-overlay',
    el('div', { class: 'card rules-card' }, [el('h2', { text: '出題履歴' }), historyPlaceholder, historyRows]),
  )

  function renderHistory() {
    const entries = [...game.askedLog].reverse() // 新しい問題が上
    historyPlaceholder.style.display = entries.length === 0 ? '' : 'none'
    historyRows.replaceChildren(
      ...entries.map((entry) => {
        const parts = []
        if (entry.answer !== '') parts.push(`答え: ${entry.answer}`)
        if (entry.decided) parts.push(entry.winners.length > 0 ? `正解: ${entry.winners.join('、')}` : '正解者なし')
        if (entry.wrongs.length > 0) parts.push(`誤答: ${entry.wrongs.join('、')}`)
        return el('div', { class: 'history-row' }, [
          el('div', { class: 'history-q' }, [
            el('span', { class: 'q-badge', text: `Q${entry.qid}` }),
            el('span', { class: 'history-text', text: entry.text !== '' ? entry.text : '（口頭で出題）' }),
          ]),
          ...(parts.length > 0 ? [el('p', { class: 'history-meta', text: parts.join(' ／ ') })] : []),
        ])
      }),
    )
  }

  const historyBtn = el('button', { class: 'btn btn-small', text: '履歴', onclick: () => {
    renderHistory()
    historyOverlay.classList.remove('hidden')
  } })

  // ゲーム全体の操作（出題の流れとは別軸なので参加者シートにまとめる）
  sheetBody.append(el('div', { class: 'btn-row' }, [historyBtn, finishBtn, resetScoresBtn]))

  // 端末設定（歯車）: 効果音の音量スライダー。動かし終わりに一鳴らしして確かめられる
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
    playLock()
  })
  // 部屋を閉じる: 回答者に終了を伝え、この端末の保存を消してトップへ戻る。
  // 単にタブを閉じるのと違い、回答者が「出題者が戻るのを待つ」画面のままにならない
  const closeRoomBtn = el('button', { class: 'btn btn-ng btn-small', text: '部屋を閉じる', onclick: () => {
    if (!window.confirm('部屋を閉じますか？回答者には終了が伝わり、この部屋には戻れなくなります。')) return
    closing = true
    transport.send({ type: MSG.CLOSED })
    clearHostRoom()
    game.destroy()
    // 終了の知らせが届く前に接続を切ってしまわないよう、少し待ってからトップへ
    setTimeout(() => {
      history.replaceState(null, '', location.pathname + location.search)
      location.reload()
    }, 300)
  } })
  const hostSettingsCard = el('div', { class: 'card rules-card' }, [
    el('h2', { text: '設定' }),
    el('div', { class: 'settings-row' }, [el('span', { text: '効果音（この端末で鳴らす）' }), volumeSlider]),
    el('div', { class: 'settings-row' }, [el('span', { text: 'この部屋を終了する' }), closeRoomBtn]),
  ])
  const hostSettingsOverlay = popupOverlay('settings-overlay', hostSettingsCard)
  const settingsBtn = el('button', {
    class: 'icon-btn',
    text: '⚙︎',
    'aria-label': '設定',
    onclick: () => hostSettingsOverlay.classList.remove('hidden'),
  })

  // --- 進行中の共有オーバーレイ ---
  const shareOverlay = el('div', { class: 'overlay share-overlay hidden' })
  shareOverlay.append(el('div', { class: 'overlay-card-wrap' }, [shareCard, closeX(shareOverlay)]))
  const openShare = () => shareOverlay.classList.remove('hidden')
  const shareBtn = el('button', { class: 'btn btn-small', text: '共有', onclick: openShare })

  // --- ルール設定オーバーレイ（回答形式・問題の表示・押下音・復帰・ハンデ） ---
  const answerModeSelect = el('select', { class: 'input' }, [
    el('option', { value: 'buzzer', text: '早押し' }),
    el('option', { value: 'ox', text: '○×クイズ（一斉回答）' }),
    el('option', { value: 'choice4', text: '4択クイズ（一斉回答）' }),
  ])
  answerModeSelect.addEventListener('change', () => game.setAnswerMode(answerModeSelect.value))

  const revealSelect = el('select', { class: 'input' }, [
    el('option', { value: 'all', text: '一括で表示' }),
    el('option', { value: 'serial', text: '順次表示（読み上げ）' }),
  ])
  revealSelect.addEventListener('change', () => {
    game.setReveal(revealSelect.value)
    syncRuleRows() // 読み上げ速度の行の表示/非表示を追従させる
  })

  const revealSpeedSelect = el('select', { class: 'input' }, [
    el('option', { value: '4', text: 'ゆっくり' }),
    el('option', { value: '7', text: 'ふつう' }),
    el('option', { value: '12', text: 'はやい' }),
  ])
  revealSpeedSelect.addEventListener('change', () => game.setRevealCps(Number(revealSpeedSelect.value)))

  const pressSoundSelect = el('select', { class: 'input' }, [
    el('option', { value: 'winner', text: '回答権を得た人だけ' }),
    el('option', { value: 'all', text: '押した全員' }),
  ])
  pressSoundSelect.addEventListener('change', () => game.setPressSound(pressSoundSelect.value))

  const hideScoresCheck = el('input', { type: 'checkbox' })
  hideScoresCheck.addEventListener('change', () => game.setHideScores(hideScoresCheck.checked))

  const rankBadgesSelect = el('select', { class: 'input' }, [
    el('option', { value: 'top3', text: '上位3人にメダル' }),
    el('option', { value: 'first', text: '1位に王冠' }),
    el('option', { value: 'none', text: 'なし' }),
  ])
  rankBadgesSelect.addEventListener('change', () => game.setRankBadges(rankBadgesSelect.value))

  const nickResumeCheck = el('input', { type: 'checkbox' })
  nickResumeCheck.addEventListener('change', () => game.setNickResume(nickResumeCheck.checked))

  // 旧端末互換モード（iOS 12 等）: マイク許可で接続候補に実IPを含め、同一Wi-Fiで直結できるようにする
  const legacyCompatBtn = el('button', { class: 'btn btn-small', text: '有効にする', onclick: async () => {
    legacyCompatBtn.disabled = true
    try {
      await transport.enableLegacyCompat()
      legacyCompatBtn.textContent = '有効'
    } catch (err) {
      // NotFoundError はマイク非搭載。詳細は接続診断にも記録される
      legacyCompatBtn.textContent = err.name === 'NotFoundError' ? 'マイクがありません' : `失敗: ${err.name}`
      legacyCompatBtn.disabled = false
    }
  } })

  // 接続診断（出題者側）
  const hostDiagText = el('div', { class: 'diag-log' })
  const hostDiagOverlay = popupOverlay(
    'diag-overlay',
    el('div', { class: 'card rules-card' }, [el('h2', { text: '接続診断' }), hostDiagText]),
  )
  const hostDiagBtn = el('button', { class: 'btn btn-small', text: '表示', onclick: () => {
    hostDiagText.textContent = diagText(40)
    hostDiagOverlay.classList.remove('hidden')
  } })

  // 接続まわりの補助は普段は不要なので、端末設定（歯車）の詳細設定に畳んでおく
  hostSettingsCard.append(
    el('details', { class: 'rules-advanced' }, [
      el('summary', { text: 'つながらない時は' }),
      el('div', { class: 'settings-row' }, [el('span', { text: '接続診断' }), hostDiagBtn]),
      el('div', { class: 'settings-row' }, [
        el('span', { text: 'この端末が iOS 12 等の旧機種のとき（マイク許可で接続候補を出す）' }),
        legacyCompatBtn,
      ]),
    ]),
  )

  // この端末が既に実IP候補を出していれば互換モードは不要（候補が集まり次第、表示に反映）
  function updateCompatButton() {
    if (!legacyCompatBtn.disabled && transport.usesMdnsCandidates() === false) {
      legacyCompatBtn.textContent = '不要（実IPが有効）'
      legacyCompatBtn.disabled = true
    }
  }

  const teamsSelect = el('select', { class: 'input' }, [
    el('option', { value: '0', text: 'なし（個人戦）' }),
    el('option', { value: '2', text: '2チーム' }),
    el('option', { value: '3', text: '3チーム' }),
    el('option', { value: '4', text: '4チーム' }),
  ])
  teamsSelect.addEventListener('change', () => game.setTeams(Number(teamsSelect.value)))
  const shuffleBtn = el('button', { class: 'btn btn-small', text: 'シャッフル', onclick: () => game.shuffleTeams() })

  const correctPointsSelect = el('select', { class: 'input' },
    [1, 2, 3, 5, 10].map((n) => el('option', { value: String(n), text: `+${n}点` })))
  correctPointsSelect.addEventListener('change', () => game.setCorrectPoints(Number(correctPointsSelect.value)))

  const wrongPointsSelect = el('select', { class: 'input' },
    [0, -1, -2, -5].map((n) => el('option', { value: String(n), text: n === 0 ? 'なし' : `${n}点` })))
  wrongPointsSelect.addEventListener('change', () => game.setWrongPoints(Number(wrongPointsSelect.value)))

  const winScoreSelect = el('select', { class: 'input' },
    [0, 5, 7, 10].map((n) => el('option', { value: String(n), text: n === 0 ? 'なし' : `${n}点` })))
  winScoreSelect.addEventListener('change', () => game.setWinScore(Number(winScoreSelect.value)))

  const handicapRows = el('div', { class: 'score-rows' })
  const handicapPlaceholder = el('p', { class: 'placeholder', text: 'まだ参加者がいません' })

  // 読み上げ速度は「順次表示」を選んだときだけ意味を持つ
  const revealSpeedRow = el('label', { class: 'settings-row' }, [el('span', { text: '読み上げ速度' }), revealSpeedSelect])
  function syncRuleRows() {
    revealSpeedRow.style.display = game.rules.reveal === 'serial' ? '' : 'none'
  }

  const settingsRow = (label, ...controls) =>
    el('label', { class: 'settings-row' }, [el('span', { text: label }), ...controls])

  // 詳細は項目が多いので、目的ごとにまとめて見出しを付ける（並べるだけだと探せない）
  const ruleGroup = (title, rows) =>
    el('section', { class: 'rules-group' }, [el('h3', { class: 'rules-group-title', text: title }), ...rows])

  // 基本は回答形式だけ。ほかは既定のままで1ゲーム成立するので、詳細にしまう
  const rulesOverlay = popupOverlay(
    'rules-overlay',
    el('div', { class: 'card rules-card' }, [
      el('h2', { text: 'ルール設定' }),
      settingsRow('回答形式', answerModeSelect),
      el('details', { class: 'rules-advanced' }, [
        el('summary', { text: '詳細設定' }),
        ruleGroup('出題', [
          settingsRow('問題の表示', revealSelect),
          revealSpeedRow,
        ]),
        ruleGroup('得点', [
          settingsRow('正解の得点', correctPointsSelect),
          settingsRow('誤答の得点', wrongPointsSelect),
          settingsRow('勝ち抜けライン', winScoreSelect),
          settingsRow('得点を隠す（結果発表で公開）', hideScoresCheck),
        ]),
        ruleGroup('チーム戦', [settingsRow('チーム分け', teamsSelect, shuffleBtn)]),
        ruleGroup('画面と音', [
          settingsRow('順位マーク', rankBadgesSelect),
          settingsRow('押下音', pressSoundSelect),
        ]),
        ruleGroup('参加者', [
          settingsRow('同名での復帰（得点引き継ぎ）', nickResumeCheck),
        ]),
        ruleGroup('ハンデ（押下時刻に加算するms）', [handicapPlaceholder, handicapRows]),
      ]),
    ]),
  )

  function openRules() {
    syncRuleRows()
    answerModeSelect.value = game.rules.answerMode
    revealSelect.value = game.rules.reveal
    revealSpeedSelect.value = String(game.rules.revealCps)
    pressSoundSelect.value = game.rules.pressSound
    rankBadgesSelect.value = game.rules.rankBadges
    hideScoresCheck.checked = game.rules.hideScores
    nickResumeCheck.checked = game.rules.nickResume
    correctPointsSelect.value = String(game.rules.correctPoints)
    wrongPointsSelect.value = String(game.rules.wrongPoints)
    winScoreSelect.value = String(game.rules.winScore)
    teamsSelect.value = String(game.rules.teams)
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

  // ルールバー: 現在のルールを要約表示するボタン。押すとルール設定が開く
  const ruleSummaryEl = el('span', { class: 'rule-summary', text: '' })
  const rulesBtn = el('button', { class: 'rule-bar', onclick: openRules }, [
    el('span', { class: 'rule-label', text: 'ルール' }),
    ruleSummaryEl,
    el('span', { class: 'rule-caret', text: '›' }),
  ])

  // 既定値から変えた「詳細設定」があるか（要約に「カスタム」と出す）
  function hasCustomDetails() {
    const r = game.rules
    return (
      r.pressSound !== 'winner' ||
      r.rankBadges !== 'top3' ||
      r.nickResume !== true ||
      [...game.players.values()].some((p) => p.handicapMs > 0)
    )
  }

  // 主要なルールを短く並べる。幅に収まらない分は CSS で末尾を省略する（左ほど重要）
  function renderRuleSummary() {
    const r = game.rules
    const parts = [r.answerMode === 'ox' ? '○×' : r.answerMode === 'choice4' ? '4択' : '早押し']
    parts.push(r.winScore > 0 ? `${r.winScore}点先取` : 'エンドレス')
    if (r.teams > 0) parts.push(`${r.teams}チーム`)
    parts.push(r.wrongPoints === 0 ? `正解+${r.correctPoints}` : `+${r.correctPoints}/${r.wrongPoints}`)
    if (r.reveal === 'serial') parts.push('読み上げ')
    if (r.hideScores) parts.push('得点非公開')
    if (hasCustomDetails()) parts.push('カスタム')
    ruleSummaryEl.textContent = parts.join(' · ')
  }

  // --- 問題集（出題者の端末にのみ保存。正本はエクスポートしたファイル） ---
  // 問題集から出題できるのは、手入力と同じく出題前と判定後だけ
  function canAskNow() {
    return game.phase === PHASE.WAITING || game.phase === PHASE.RESULT
  }

  // 問題集から選んだ問題を入力欄に読み込む（この時点ではまだ回答者には出さない。
  // 内容を確かめて必要なら直してから「問題を表示」で出題する）
  function loadFromBank(item) {
    if (!canAskNow()) return // 進行中の問題を壊さない
    currentBankId = item.id
    // 問題の形式に合わせて回答形式のルールも切り替える（4択の問題を早押しで出さない）
    if (game.rules.answerMode !== item.type) game.setAnswerMode(item.type)
    questionInput.value = item.q
    askFields.sync(item.type)
    lastAskFieldsMode = item.type
    askFields.setValues(item.type, { raw: item.a, choices: item.choices })
    bankOverlay.classList.add('hidden')
    render()
  }

  // 問題集の UI は編集専用ページと共用（出題つきで組み立てる）
  const bankPanel = createBankPanel({ items: bankItems, onAsk: loadFromBank, canAsk: canAskNow })
  const bankOverlay = popupOverlay('bank-overlay', bankPanel.root, { wide: true })
  const bankBtn = el('button', { class: 'link-btn', text: '問題集から選ぶ', onclick: () => {
    // いまのルールの回答形式で絞って開く（○×のルールで4択の問題を見せても選べない）
    bankPanel.presetType(game.rules.answerMode)
    bankOverlay.classList.remove('hidden')
  } })

  // ポップアップは範囲外タップでも閉じる
  backdropDismiss(shareOverlay, rulesOverlay, bankOverlay, hostDiagOverlay, hostSettingsOverlay, historyOverlay)

  // --- 画面（最初から進行画面。共有はポップアップで開いた状態から始まる） ---

  // 出題と進行は1枚のカードにまとめ、操作ボタンはその時点で押せるものだけを出す
  const actionRow = el('div', { class: 'action-grid' })
  const judgeRow = el('div', { class: 'judge-row' }, [correctBtn, wrongNextBtn])
  // 誤答にしたあとの進め方。基本は「誤答」で足りるので控えめに置く
  const wrongMoreRow = el('div', { class: 'wrong-more' }, [wrongOpenBtn, wrongTeamBtn])

  function showGame() {
    app.replaceChildren(
      el('div', { class: 'screen host-screen' }, [
        topbar([shareBtn, settingsBtn]),
        rulesBtn,
        el('div', { class: 'card' }, [
          el('div', { class: 'topbar' }, [
            el('span', { class: 'card-title' }, [el('h2', { text: '出題' }), hostQBadge]),
            bankBtn, // 出題の材料を選ぶ導線なので、控えめに右端へ置く
          ]),
          stepBar,
          questionInput,
          askFields.row,
          currentQuestionEl,
          answerLine,
          answersLine,
          orderPlaceholder,
          orderList,
          resultLine,
          judgeRow,
          wrongMoreRow,
          declareRow,
          actionRow,
        ]),
      ]),
      scoreSheet,
      shareOverlay,
      rulesOverlay,
      bankOverlay,
      hostDiagOverlay,
      hostSettingsOverlay,
      historyOverlay,
      bankPanel.ioOverlay, // 問題集の上に重ねて出す
    )
  }

  // --- 描画（game の状態を反映するだけ。状態遷移は HostGame が持つ） ---

  let prevPhase = game.phase
  let revealTimer = null
  let lastDeclareMode = null
  let lastAskFieldsMode = null

  function answerValueLabel(value) {
    if (game.rules.answerMode === 'ox') return value === 'o' ? '○' : '×'
    return value
  }

  // 問題文の表示（順次表示ルールでは読み上げ位置までを描画する）。問題番号は Q バッジが伝える
  function renderQuestionText() {
    // 問題文は基本的に入力欄が持っている。ここに出すのは入力欄では分からないとき、
    // すなわち「読み上げがどこまで公開されたか」と「判定後に入力欄を空にした後」
    const serialProgress =
      game.rules.reveal === 'serial' &&
      (game.phase === PHASE.QUESTION || game.phase === PHASE.ARMED || game.phase === PHASE.LOCKED)
    const visible = game.qid > 0 && game.phase !== PHASE.FINAL && (serialProgress || game.phase === PHASE.RESULT)
    currentQuestionEl.style.display = visible ? '' : 'none'
    if (!visible) return
    if (game.questionText === '') {
      currentQuestionEl.textContent = '（口頭で出題）'
      return
    }
    if (game.rules.reveal === 'serial') {
      let chars = game.revealBase
      if (game.phase === PHASE.ARMED && game.armedAt !== null) {
        chars += (game.rules.revealCps * (performance.now() - game.armedAt)) / 1000
      }
      const count = Math.min(game.questionText.length, Math.floor(chars))
      currentQuestionEl.textContent =
        count <= 0 ? '（早押し開始で読み上げ）' : game.questionText.slice(0, count)
    } else {
      currentQuestionEl.textContent = game.questionText
    }
  }

  function render() {
    if (game.phase === PHASE.LOCKED && prevPhase !== PHASE.LOCKED) playLock()
    // 判定が終わったら入力欄を空にして次の問題を受け付ける
    // （取り消しで WAITING に戻った場合は編集して出し直せるよう問題文を残す）
    if (game.phase === PHASE.RESULT && prevPhase !== PHASE.RESULT) {
      questionInput.value = ''
      askFields.clear()
    }
    prevPhase = game.phase

    const connectedCount = [...game.players.values()].filter((p) => p.connected).length
    sheetSummary.textContent = `参加者 ${connectedCount}人`
    renderRuleSummary()
    updateCompatButton()

    renderSteps()
    // バッジはステップ表示と足並みをそろえる。①「問題を用意」の間は、
    // これから出す番号を出す（1問目の前なら Q1、Q1の判定後なら Q2）
    const preparing = game.phase === PHASE.WAITING || game.phase === PHASE.RESULT
    const badgeVisible = game.phase !== PHASE.FINAL
    hostQBadge.textContent = badgeVisible ? `Q${preparing ? game.qid + 1 : game.qid}` : ''
    hostQBadge.classList.toggle('ghost', !badgeVisible)
    renderQuestionText()
    // 読み上げ中はアニメーションのために定期再描画する
    const revealing = game.rules.reveal === 'serial' && game.phase === PHASE.ARMED
    if (revealing && revealTimer === null) {
      revealTimer = setInterval(renderQuestionText, 100)
    } else if (!revealing && revealTimer !== null) {
      clearInterval(revealTimer)
      revealTimer = null
    }

    const mass = game.isMassAnswerMode
    // 出題できるのは出題前と判定後だけ。表示中・受付中・判定中に出し直すと
    // 進行中の問題を壊すため、「取り消し」や「受付停止」で戻してから出し直す
    const canAsk = game.phase === PHASE.WAITING || game.phase === PHASE.RESULT
    armBtn.textContent = mass ? '回答受付開始' : '早押し開始'
    finishBtn.textContent = game.phase === PHASE.FINAL ? 'ゲームに戻る' : '結果発表'

    // その時点で押せるボタンだけを並べる（非活性のボタンは並べない）
    const actions = []
    if (canAsk) actions.push(showBtn)
    if (game.phase === PHASE.QUESTION) actions.push(armBtn, cancelBtn)
    if (mass && game.phase === PHASE.ARMED) actions.push(closeAnswersBtn)
    if (!mass && (game.phase === PHASE.ARMED || game.phase === PHASE.LOCKED)) actions.push(stopBtn)
    actionRow.replaceChildren(...actions)
    actionRow.style.display = actions.length === 0 ? 'none' : ''
    // 「次にこれを押す」1つだけを脈動させて迷わせない（判定は人の判断なので強調しない）
    const nextUp = canAsk ? showBtn : game.phase === PHASE.QUESTION ? armBtn : mass && game.phase === PHASE.ARMED ? closeAnswersBtn : null
    for (const button of [showBtn, armBtn, closeAnswersBtn]) {
      button.classList.toggle('next-up', button === nextUp)
    }
    // 問題文は入力欄に表示したまま、出題中は編集できないようにする
    const inputsVisible = game.phase !== PHASE.FINAL
    questionInput.style.display = inputsVisible ? '' : 'none'
    questionInput.disabled = !canAsk
    // 答え・選択肢の入力欄は回答形式に追従させる
    if (lastAskFieldsMode !== game.rules.answerMode) {
      lastAskFieldsMode = game.rules.answerMode
      askFields.sync(game.rules.answerMode)
    }
    askFields.row.style.display = inputsVisible ? '' : 'none'
    askFields.setDisabled(!canAsk)

    // 一斉回答の正答宣言は締め切り後だけ
    const canDeclare = mass && game.phase === PHASE.LOCKED
    declareRow.style.display = canDeclare ? '' : 'none'
    // 問題が変われば「正解を発表」の中身も変わるため、正解値も鍵に含める
    const declareKey = `${game.rules.answerMode}:${game.plannedCorrect ?? ''}:${game.answerText}`
    if (mass && lastDeclareMode !== declareKey) {
      lastDeclareMode = declareKey
      buildDeclareButtons()
    }

    // 問題集のメモ（判定基準など）だけ手元に出す。答えと選択肢は入力欄に入っている
    const bankItem = currentBankId !== null ? bankItems.find((i) => i.id === currentBankId) : undefined
    const memo = bankItem !== undefined ? bankItem.memo : ''
    answerLine.textContent = memo !== '' ? `メモ: ${memo}` : ''
    answerLine.className = memo !== '' ? 'answer-note' : 'answer-note hidden'
    // 判定ボタンは誰かが押して判定できるときだけ出す（待機中の画面を静かに保つ）
    const canJudge = !mass && game.phase === PHASE.LOCKED && game.activePlayerId !== null
    judgeRow.style.display = canJudge ? '' : 'none'
    wrongMoreRow.style.display = canJudge ? '' : 'none'
    wrongTeamBtn.style.display = game.rules.teams > 0 ? '' : 'none'

    // チーム合計（チーム戦のみ）
    if (game.rules.teams > 0) {
      const players = [...game.players.values()]
      teamTotalsRow.replaceChildren(
        ...teamTotals(players, game.rules.teams).map((t) => {
          const meta = teamMeta(t.team)
          return el('span', { class: `team-chip ${meta.cls}`, text: `${meta.label} ${t.score}点` })
        }),
      )
    } else {
      teamTotalsRow.replaceChildren()
    }

    // 判定結果の表示
    if (game.result !== null) {
      if (game.result.correct) {
        const winner = game.players.get(game.result.playerId)
        resultLine.textContent = `正解: ${winner !== undefined ? winner.nick : '？'} さん（+${game.rules.correctPoints}点）`
        resultLine.className = 'result-line ok'
      } else {
        resultLine.textContent = '正解者なし'
        resultLine.className = 'result-line ng'
      }
    } else if (mass && game.correctValue !== null) {
      const correctCount = [...game.answers.values()].filter((v) => v === game.correctValue).length
      resultLine.textContent = `正解は${answerValueLabel(game.correctValue)}（${correctCount}人正解）`
      resultLine.className = 'result-line ok'
    } else {
      resultLine.className = 'result-line hidden'
    }

    if (mass) {
      // 一斉回答: 受付中は回答済み人数のみ、締切後に回答内容を一覧表示
      orderPlaceholder.style.display = 'none'
      if (game.phase === PHASE.ARMED) {
        answersLine.textContent = `回答済み ${game.answers.size}/${connectedCount}人`
        answersLine.style.display = ''
      } else {
        answersLine.style.display = 'none'
      }
      if (game.phase === PHASE.LOCKED || game.phase === PHASE.RESULT) {
        orderList.replaceChildren(
          ...[...game.answers.entries()].map(([playerId, value]) => {
            const player = game.players.get(playerId)
            const isCorrect = game.correctValue !== null && value === game.correctValue
            return el('li', { class: orderRowClass(playerId) }, [
              el('span', { class: 'order-nick', text: player !== undefined ? player.nick : '？' }),
              el('span', { class: 'order-delta', text: answerValueLabel(value) }),
              ...(game.correctValue !== null
                ? [el('span', { class: isCorrect ? 'badge active' : 'badge ng', text: isCorrect ? '正解' : '不正解' })]
                : []),
            ])
          }),
        )
        shownRowIds = new Set(game.answers.keys())
      } else {
        orderList.replaceChildren()
        shownRowIds = new Set()
      }
    } else {
      // 押下順リスト（1位からのms差）。案内文は受付が始まってからにして待機中を静かに保つ
      answersLine.style.display = 'none'
      const orderRelevant =
        game.phase === PHASE.ARMED || game.phase === PHASE.LOCKED || game.phase === PHASE.RESULT
      orderPlaceholder.style.display = orderRelevant && game.order.length === 0 ? '' : 'none'
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
          return el('li', { class: orderRowClass(entry.playerId) }, [
            el('span', { class: 'order-nick', text: player !== undefined ? player.nick : '？' }),
            el('span', { class: 'order-delta', text: `+${entry.deltaMs.toFixed(1)}ms` }),
            ...badges,
          ])
        }),
      )
      shownRowIds = new Set(game.order.map((entry) => entry.playerId))
    }

    // 参加者・得点（手動加減点つき）
    const players = [...game.players.values()]
    scorePlaceholder.style.display = players.length === 0 ? '' : 'none'
    scoreRows.replaceChildren(
      ...players.map((p) => {
        const meta = game.rules.teams > 0 ? teamMeta(p.team) : null
        const mark = rankMark(players, p, game.rules.rankBadges)
        return el('div', { class: 'score-row' }, [
          el('span', { class: p.connected ? 'dot on' : 'dot off' }),
          ...(mark !== '' ? [el('span', { class: 'rank-mark', text: mark })] : []),
          // タップでチームを順に切り替えられる
          ...(meta !== null
            ? [el('button', {
                class: `team-chip ${meta.cls}`,
                text: meta.label,
                onclick: () => game.cycleTeam(p.sessionId),
              })]
            : []),
          el('span', { class: 'score-nick', text: p.nick }),
          ...(game.rules.winScore > 0 && p.score >= game.rules.winScore
            ? [el('span', { class: 'badge win', text: '勝ち抜け' })]
            : []),
          ...(p.handicapMs > 0
            ? [el('span', { class: 'handicap-note', text: `ハンデ+${p.handicapMs}ms` })]
            : []),
          el('span', {
            class: 'score-rtt',
            text: p.sync.rtt !== null ? `${Math.round(p.sync.rtt)}ms` : '',
          }),
          el('span', { class: 'score-value', text: String(p.score) }),
          el('button', { class: 'btn btn-mini', text: '−', onclick: () => game.adjustScore(p.sessionId, -1) }),
          el('button', { class: 'btn btn-mini', text: '＋', onclick: () => game.adjustScore(p.sessionId, 1) }),
        ])
      }),
    )
  }

  if (resuming) {
    // 出題中に離れていたなら、問題文と答えを入力欄に戻す（出題中は編集不可のまま表示される）
    if (game.phase === PHASE.QUESTION || game.phase === PHASE.LOCKED) {
      const mode = game.rules.answerMode
      questionInput.value = game.questionText
      askFields.sync(mode)
      lastAskFieldsMode = mode
      askFields.setValues(mode, {
        raw: mode === 'buzzer' ? game.answerText : game.plannedCorrect ?? '',
        choices: game.choices,
      })
    }
    showGame()
    showToast('前の部屋に戻りました', 'ok') // 回答者が自動でつながり直すことはトップ画面で伝えている
  } else {
    showGame()
    openShare() // 部屋を作った直後は共有（QR・URL）を開いた状態で参加者を集める
  }
  render()
  persist() // 参加者が来る前にリロードしても、同じルームコードで続けられるように
  transport.join(roomCode).catch(() => {}) // 失敗内容は診断ログに記録済み
}
