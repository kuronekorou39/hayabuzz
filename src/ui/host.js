import QRCode from 'qrcode'
import { playCorrect, playLock, playWrong, setSoundEnabled, unlockAudio } from '../audio.js'
import { CONFIG } from '../config.js'
import { HostGame } from '../game/host-game.js'
import { PHASE, PHASE_LABEL } from '../game/phases.js'
import {
  addQuestion,
  exportPayload,
  getExportedAt,
  importTsv,
  loadBank,
  markAsked,
  nextUnasked,
  parseImport,
  recordWinner,
  removeQuestion,
  saveBank,
  setExportedAt,
} from '../game/question-bank.js'
import { teamMeta, teamTotals } from '../game/teams.js'
import { diagText } from '../net/diag.js'
import { validateMessage } from '../net/protocol.js'
import { createTransport } from '../net/transport.js'
import { loadPrefs, savePrefs } from '../prefs.js'
import { el } from '../util/dom.js'
import { randomCode } from '../util/random.js'

export function mountHost(app) {
  unlockAudio() // トップ画面のクリック（ユーザー操作）を起点に AudioContext を有効化
  const prefs = loadPrefs()
  setSoundEnabled(prefs.sound)
  // 問題セット等のブラウザ保存が自動削除されにくいよう永続化を要求（対応ブラウザのみ）
  navigator.storage?.persist?.().catch(() => {})

  const bankItems = loadBank()
  let currentBankId = null // いま出題中のセット問題（答え・メモの手元表示と履歴記録に使う）
  let outcomeRecorded = false

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
  const teamTotalsRow = el('div', { class: 'team-totals' })
  const scoreCard = el('div', { class: 'card' }, [
    el('h2', { text: '参加者・得点' }),
    teamTotalsRow,
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
    currentBankId = null // 手入力の出題はセットと紐付けない
    game.showQuestion(questionInput.value)
    questionInput.value = ''
  } })
  const askNextBtn = el('button', { class: 'btn', text: 'セットから次を出題', onclick: () => {
    const item = nextUnasked(bankItems)
    if (item === null) return
    askFromBank(item)
  } })
  const armBtn = el('button', { class: 'btn btn-arm', text: '早押し開始', onclick: () => game.arm() })
  const stopBtn = el('button', { class: 'btn', text: '受付停止', onclick: () => game.stop() })
  const closeAnswersBtn = el('button', { class: 'btn', text: '締め切り', onclick: () => game.closeAnswers() })

  const phaseEl = el('span', { class: 'phase-chip', text: PHASE_LABEL[PHASE.WAITING] })
  const currentQuestionEl = el('div', { class: 'question-text question-clamp', text: 'まだ問題がありません' })
  const answerLine = el('p', { class: 'answer-note hidden', text: '' }) // 答え・メモ（出題者の手元のみ）
  const orderList = el('ol', { class: 'order-list' })
  const orderPlaceholder = el('p', { class: 'placeholder', text: 'まだ誰も押していません' })
  const resultLine = el('p', { class: 'result-line hidden', text: '' })
  // セット問題の判定結果（出題日時と正解者名）を履歴に書き込む
  function recordOutcome() {
    if (outcomeRecorded || currentBankId === null) return
    if (game.phase !== PHASE.RESULT || game.result === null) return
    const winner = game.result.correct
      ? (game.players.get(game.result.playerId)?.nick ?? null)
      : null
    recordWinner(bankItems, currentBankId, winner)
    saveBank(bankItems)
    outcomeRecorded = true
  }

  const correctBtn = el('button', { class: 'btn btn-ok', text: '正解', onclick: () => {
    playCorrect()
    game.judgeCorrect()
    recordOutcome()
  } })
  const wrongNextBtn = el('button', { class: 'btn btn-ng', text: '不正解→次点へ', onclick: () => {
    playWrong()
    game.judgeWrongNext()
    recordOutcome() // 次点がおらず正解者なしで決着した場合の記録
  } })
  const wrongOpenBtn = el('button', { class: 'btn btn-ng', text: '不正解→全員再開放', onclick: () => {
    playWrong()
    game.judgeWrongReopen()
  } })
  const wrongTeamBtn = el('button', { class: 'btn btn-ng', text: '不正解→他チームに開放', onclick: () => {
    playWrong()
    game.judgeWrongOpenOtherTeams()
  } })

  // 一斉回答モードの回答状況と正答宣言
  const answersLine = el('p', { class: 'placeholder answers-line', text: '' })
  const declareRow = el('div', { class: 'btn-row' })

  function buildDeclareButtons() {
    const options =
      game.rules.answerMode === 'ox'
        ? [{ value: 'o', label: '正解は○' }, { value: 'x', label: '正解は×' }]
        : ['1', '2', '3', '4'].map((n) => ({ value: n, label: `正解は${n}` }))
    declareRow.replaceChildren(
      ...options.map((option) =>
        el('button', { class: 'btn btn-ok', text: option.label, onclick: () => {
          playCorrect()
          game.declareCorrect(option.value)
        } }),
      ),
    )
  }

  const finishBtn = el('button', { class: 'btn', text: '結果発表', onclick: () => {
    if (game.phase === PHASE.FINAL) game.resumeGame()
    else game.finishGame()
  } })
  const resetScoresBtn = el('button', { class: 'btn btn-ng', text: '得点リセット', onclick: () => game.resetScores() })

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
  revealSelect.addEventListener('change', () => game.setReveal(revealSelect.value))

  const revealSpeedSelect = el('select', { class: 'input' }, [
    el('option', { value: '4', text: 'ゆっくり' }),
    el('option', { value: '7', text: 'ふつう' }),
    el('option', { value: '12', text: 'はやい' }),
  ])
  revealSpeedSelect.addEventListener('change', () => game.setRevealCps(Number(revealSpeedSelect.value)))

  const pressSoundSelect = el('select', { class: 'input' }, [
    el('option', { value: 'winner', text: '回答権を得た人だけ鳴る' }),
    el('option', { value: 'all', text: '押した全員に鳴る' }),
  ])
  pressSoundSelect.addEventListener('change', () => game.setPressSound(pressSoundSelect.value))

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
  const hostDiagOverlay = el('div', { class: 'overlay diag-overlay hidden' }, [
    el('div', { class: 'card rules-card' }, [el('h2', { text: '接続診断' }), hostDiagText]),
    el('button', { class: 'btn btn-primary', text: '閉じる', onclick: () => hostDiagOverlay.classList.add('hidden') }),
  ])
  const hostDiagBtn = el('button', { class: 'btn btn-small', text: '接続診断を表示', onclick: () => {
    hostDiagText.textContent = diagText(40)
    hostDiagOverlay.classList.remove('hidden')
  } })

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
  const rulesOverlay = el('div', { class: 'overlay rules-overlay hidden' }, [
    el('div', { class: 'card rules-card' }, [
      el('h2', { text: 'ルール設定' }),
      el('label', { class: 'settings-row' }, [el('span', { text: '回答形式' }), answerModeSelect]),
      el('label', { class: 'settings-row' }, [el('span', { text: '問題の表示' }), revealSelect]),
      el('label', { class: 'settings-row' }, [el('span', { text: '読み上げ速度' }), revealSpeedSelect]),
      el('label', { class: 'settings-row' }, [el('span', { text: '押下音' }), pressSoundSelect]),
      el('label', { class: 'settings-row' }, [el('span', { text: '正解の得点' }), correctPointsSelect]),
      el('label', { class: 'settings-row' }, [el('span', { text: '誤答の得点' }), wrongPointsSelect]),
      el('label', { class: 'settings-row' }, [el('span', { text: '勝ち抜けライン' }), winScoreSelect]),
      el('label', { class: 'settings-row' }, [el('span', { text: 'チーム戦' }), teamsSelect, shuffleBtn]),
      el('label', { class: 'settings-row' }, [
        el('span', { text: '同名での復帰（得点引き継ぎ）' }),
        nickResumeCheck,
      ]),
      el('div', { class: 'settings-row' }, [
        el('span', { text: '旧端末互換（iOS 12等・マイク許可を使用）' }),
        legacyCompatBtn,
      ]),
      el('div', { class: 'settings-row' }, [el('span', { text: 'つながらない時に' }), hostDiagBtn]),
      el('h2', { text: 'ハンデ（押下時刻に加算するms）' }),
      handicapPlaceholder,
      handicapRows,
    ]),
    el('button', { class: 'btn btn-primary', text: '閉じる', onclick: () => rulesOverlay.classList.add('hidden') }),
  ])

  function openRules() {
    answerModeSelect.value = game.rules.answerMode
    revealSelect.value = game.rules.reveal
    revealSpeedSelect.value = String(game.rules.revealCps)
    pressSoundSelect.value = game.rules.pressSound
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

  const rulesBtn = el('button', { class: 'btn btn-small', text: 'ルール', onclick: openRules })

  // --- 問題セット（出題者の端末にのみ保存。正本はエクスポートしたファイル） ---
  function askFromBank(item) {
    if (game.phase === PHASE.ARMED || game.phase === PHASE.LOCKED) return // 進行中の問題を壊さない
    currentBankId = item.id
    outcomeRecorded = false
    markAsked(bankItems, item.id, Date.now())
    saveBank(bankItems)
    questionInput.value = ''
    game.showQuestion(item.q)
    bankOverlay.classList.add('hidden')
  }

  const bankQInput = el('input', { class: 'input bank-q-input', type: 'text', placeholder: '問題文', maxlength: CONFIG.questionMaxLen })
  const bankAInput = el('input', { class: 'input bank-a-input', type: 'text', placeholder: '答え', maxlength: 200 })
  const bankMemoInput = el('input', { class: 'input bank-memo-input', type: 'text', placeholder: 'メモ（判定基準など）', maxlength: 500 })
  const bankAddBtn = el('button', { class: 'btn btn-primary btn-small', text: '追加', onclick: () => {
    const item = addQuestion(bankItems, {
      q: bankQInput.value,
      a: bankAInput.value,
      memo: bankMemoInput.value,
    })
    if (item === null) return
    saveBank(bankItems)
    bankQInput.value = ''
    bankAInput.value = ''
    bankMemoInput.value = ''
    renderBank()
    bankQInput.focus()
  } })

  const bankRows = el('div', { class: 'bank-rows' })
  const bankPlaceholder = el('p', { class: 'placeholder', text: 'まだ問題がありません。下で追加するか、貼り付け取り込みが使えます。' })

  const bankPaste = el('textarea', {
    class: 'input bank-paste',
    rows: '3',
    placeholder: '貼り付け取り込み: 1行1問「問題 (タブ) 答え (タブ) メモ」。表計算からのコピペでOK',
  })
  const bankImportBtn = el('button', { class: 'btn btn-small', text: '取り込み', onclick: () => {
    const count = importTsv(bankItems, bankPaste.value)
    if (count > 0) {
      saveBank(bankItems)
      bankPaste.value = ''
      renderBank()
    }
  } })

  const exportNote = el('p', { class: 'placeholder', text: '' })
  const exportBtn = el('button', { class: 'btn btn-small', text: 'ファイルへエクスポート', onclick: () => {
    const blob = new Blob([exportPayload(bankItems)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = el('a', { href: url, download: `hayabuzz-questions-${new Date().toISOString().slice(0, 10)}.json` })
    link.click()
    URL.revokeObjectURL(url)
    setExportedAt(Date.now())
    renderBank()
  } })
  const importFileInput = el('input', { class: 'bank-file-input', type: 'file', accept: 'application/json' })
  importFileInput.addEventListener('change', () => {
    const file = importFileInput.files[0]
    importFileInput.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const questions = parseImport(String(reader.result))
      if (questions === null) {
        exportNote.textContent = '読み込めませんでした（エクスポートしたファイルを指定してください）'
        return
      }
      bankItems.length = 0
      bankItems.push(...questions)
      saveBank(bankItems)
      renderBank()
    }
    reader.readAsText(file)
  })
  const importLabel = el('label', { class: 'btn btn-small' }, [
    el('span', { text: 'ファイルから復元' }),
    importFileInput,
  ])

  function formatAskedMeta(item) {
    if (item.history.length === 0) return '未出題'
    const last = item.history[item.history.length - 1]
    const date = new Date(last.at)
    const when = `${date.getMonth() + 1}/${date.getDate()}`
    const winner = last.winner !== null ? ` ${last.winner}` : ' 正解者なし'
    return `${item.history.length}回 · ${when}${winner}`
  }

  function renderBank() {
    bankPlaceholder.style.display = bankItems.length === 0 ? '' : 'none'
    bankRows.replaceChildren(
      ...bankItems.map((item) =>
        el('div', { class: 'bank-row' }, [
          el('div', { class: 'bank-main' }, [
            el('span', { class: 'bank-q', text: item.q }),
            el('span', { class: 'bank-meta', text: `${item.a !== '' ? `答え: ${item.a} · ` : ''}${formatAskedMeta(item)}` }),
          ]),
          el('button', { class: 'btn btn-mini', text: '出題', onclick: () => askFromBank(item) }),
          el('button', { class: 'btn btn-mini', text: '削除', onclick: () => {
            removeQuestion(bankItems, item.id)
            saveBank(bankItems)
            renderBank()
          } }),
        ]),
      ),
    )
    const exportedAt = getExportedAt()
    exportNote.textContent =
      exportedAt !== null
        ? `最終エクスポート: ${new Date(exportedAt).toLocaleString()}（ブラウザ保存は消えることがあるため、定期的なエクスポートを推奨）`
        : 'ブラウザ保存は消えることがあります。作ったらエクスポートしてファイルを正本にしてください'
  }

  const bankOverlay = el('div', { class: 'overlay bank-overlay hidden' }, [
    el('div', { class: 'card rules-card' }, [
      el('h2', { text: '問題セット' }),
      bankPlaceholder,
      bankRows,
      el('div', { class: 'bank-add' }, [bankQInput, bankAInput, bankMemoInput, bankAddBtn]),
      bankPaste,
      el('div', { class: 'btn-row' }, [bankImportBtn, exportBtn, importLabel]),
      exportNote,
    ]),
    el('button', { class: 'btn btn-primary', text: '閉じる', onclick: () => bankOverlay.classList.add('hidden') }),
  ])
  const bankBtn = el('button', { class: 'btn btn-small', text: 'セット', onclick: () => {
    renderBank()
    bankOverlay.classList.remove('hidden')
  } })

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
      hostDiagOverlay,
    )
  }

  function showGame() {
    app.replaceChildren(
      el('div', { class: 'screen host-screen' }, [
        topbar([bankBtn, rulesBtn, shareBtn]),
        el('div', { class: 'card' }, [
          el('h2', { text: '問題' }),
          questionInput,
          el('div', { class: 'btn-row' }, [showBtn, askNextBtn, armBtn, stopBtn, closeAnswersBtn]),
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'topbar' }, [el('h2', { text: '進行' }), phaseEl]),
          currentQuestionEl,
          answerLine,
          answersLine,
          orderPlaceholder,
          orderList,
          resultLine,
          el('div', { class: 'btn-row' }, [correctBtn, wrongNextBtn, wrongOpenBtn, wrongTeamBtn]),
          declareRow,
          el('div', { class: 'btn-row' }, [finishBtn, resetScoresBtn]),
          el('label', { class: 'settings-row' }, [el('span', { text: '効果音（この端末で鳴らす）' }), soundCheck]),
        ]),
        scoreCard,
      ]),
      shareOverlay,
      rulesOverlay,
      bankOverlay,
      hostDiagOverlay,
    )
  }

  // --- 描画（game の状態を反映するだけ。状態遷移は HostGame が持つ） ---

  let prevPhase = game.phase
  let revealTimer = null
  let lastDeclareMode = null

  function answerValueLabel(value) {
    if (game.rules.answerMode === 'ox') return value === 'o' ? '○' : '×'
    return value
  }

  // 問題文の表示（順次表示ルールでは読み上げ位置までを描画する）
  function renderQuestionText() {
    if (game.qid === 0) {
      currentQuestionEl.textContent = 'まだ問題がありません'
      return
    }
    if (game.questionText === '') {
      currentQuestionEl.textContent = `第${game.qid}問（口頭で出題）`
      return
    }
    const prefix = `第${game.qid}問: `
    if (game.rules.reveal === 'serial') {
      let chars = game.revealBase
      if (game.phase === PHASE.ARMED && game.armedAt !== null) {
        chars += (game.rules.revealCps * (performance.now() - game.armedAt)) / 1000
      }
      const count = Math.min(game.questionText.length, Math.floor(chars))
      currentQuestionEl.textContent =
        count <= 0 ? `${prefix}（早押し開始で読み上げ）` : prefix + game.questionText.slice(0, count)
    } else {
      currentQuestionEl.textContent = prefix + game.questionText
    }
  }

  function render() {
    if (game.phase === PHASE.LOCKED && prevPhase !== PHASE.LOCKED) playLock()
    prevPhase = game.phase

    const connectedCount = [...game.players.values()].filter((p) => p.connected).length
    statusText.textContent = `部屋を公開中 · 参加 ${connectedCount}人`

    phaseEl.textContent = PHASE_LABEL[game.phase]
    phaseEl.className = `phase-chip phase-${game.phase}`
    renderQuestionText()
    // 読み上げ中はアニメーションのために定期再描画する
    const revealing = game.rules.reveal === 'serial' && game.phase === PHASE.ARMED
    if (revealing && revealTimer === null) {
      revealTimer = setInterval(renderQuestionText, 100)
    } else if (!revealing && revealTimer !== null) {
      clearInterval(revealTimer)
      revealTimer = null
    }

    // 受付中・判定中の「問題を表示」は進行中の問題を破棄してしまうため無効化する
    // （仕切り直したいときは「受付停止」で一旦戻す）
    showBtn.textContent = game.phase === PHASE.RESULT ? '次の問題を表示' : '問題を表示'
    showBtn.disabled = game.phase === PHASE.ARMED || game.phase === PHASE.LOCKED
    askNextBtn.disabled = showBtn.disabled || nextUnasked(bankItems) === null

    // 回答形式によるボタンの出し分け
    const mass = game.isMassAnswerMode
    armBtn.textContent = mass ? '回答受付開始' : '早押し開始'
    stopBtn.style.display = mass ? 'none' : ''
    closeAnswersBtn.style.display = mass ? '' : 'none'
    closeAnswersBtn.disabled = game.phase !== PHASE.ARMED
    finishBtn.textContent = game.phase === PHASE.FINAL ? 'ゲームに戻る' : '結果発表'
    declareRow.style.display = mass ? '' : 'none'
    if (mass && lastDeclareMode !== game.rules.answerMode) {
      lastDeclareMode = game.rules.answerMode
      buildDeclareButtons()
    }
    for (const button of declareRow.children) button.disabled = game.phase !== PHASE.LOCKED

    // セット問題の答え・メモ（この端末にだけ表示。P2Pには流れない）
    const bankItem = currentBankId !== null ? bankItems.find((i) => i.id === currentBankId) : undefined
    if (bankItem !== undefined) {
      const memo = bankItem.memo !== '' ? ` ／ メモ: ${bankItem.memo}` : ''
      answerLine.textContent = `答え: ${bankItem.a !== '' ? bankItem.a : '（未記入）'}${memo}`
      answerLine.className = 'answer-note'
    } else {
      answerLine.className = 'answer-note hidden'
    }
    armBtn.disabled = game.phase !== PHASE.QUESTION
    stopBtn.disabled = game.phase !== PHASE.ARMED && game.phase !== PHASE.LOCKED
    const canJudge = !mass && game.phase === PHASE.LOCKED && game.activePlayerId !== null
    correctBtn.disabled = !canJudge
    wrongNextBtn.disabled = !canJudge
    wrongOpenBtn.disabled = !canJudge
    wrongTeamBtn.disabled = !canJudge
    correctBtn.style.display = mass ? 'none' : ''
    wrongNextBtn.style.display = mass ? 'none' : ''
    wrongOpenBtn.style.display = mass ? 'none' : ''
    wrongTeamBtn.style.display = mass || game.rules.teams === 0 ? 'none' : ''

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
            return el('li', { class: 'order-row' }, [
              el('span', { class: 'order-nick', text: player !== undefined ? player.nick : '？' }),
              el('span', { class: 'order-delta', text: answerValueLabel(value) }),
              ...(game.correctValue !== null
                ? [el('span', { class: isCorrect ? 'badge active' : 'badge ng', text: isCorrect ? '正解' : '不正解' })]
                : []),
            ])
          }),
        )
      } else {
        orderList.replaceChildren()
      }
    } else {
      // 押下順リスト（1位からのms差）
      answersLine.style.display = 'none'
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
    }

    // 参加者・得点（手動加減点つき）
    const players = [...game.players.values()]
    scorePlaceholder.style.display = players.length === 0 ? '' : 'none'
    scoreRows.replaceChildren(
      ...players.map((p) => {
        const meta = game.rules.teams > 0 ? teamMeta(p.team) : null
        return el('div', { class: 'score-row' }, [
          el('span', { class: p.connected ? 'dot on' : 'dot off' }),
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
            text: p.sync.rtt !== null ? `RTT ${Math.round(p.sync.rtt)}ms` : '',
          }),
          el('span', { class: 'score-value', text: String(p.score) }),
          el('button', { class: 'btn btn-mini', text: '−', onclick: () => game.adjustScore(p.sessionId, -1) }),
          el('button', { class: 'btn btn-mini', text: '＋', onclick: () => game.adjustScore(p.sessionId, 1) }),
        ])
      }),
    )
  }

  showLobby()
  render()
  transport.join(roomCode).catch(() => {}) // 失敗内容は診断ログに記録済み
}
