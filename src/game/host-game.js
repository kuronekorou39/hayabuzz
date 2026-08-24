import { CONFIG } from '../config.js'
import { MSG, PROTO_VERSION } from '../net/protocol.js'
import { PeerSync } from '../net/timesync.js'
import { judgeBuzzes, pickActive, toHostTime } from './buzz.js'
import { PHASE } from './phases.js'

// host 権威の状態機械。参加者・フェーズ・押下順・得点の唯一の信頼できる状態を持ち、
// 変化のたびに state スナップショットを全 player へ配信する。
// player からの自己申告値（得点等）は一切受け付けない（プロトコルに存在しない）。
export class HostGame {
  constructor({ send, onChange = () => {}, now = () => performance.now() }) {
    this.send = send // (msg, peerId?) => void
    this.onChange = onChange // host UI の再描画用
    this.now = now
    this.players = new Map() // sessionId → player 記録（切断後も保持し再接続で引き継ぐ）
    this.phase = PHASE.WAITING
    this.qid = 0
    this.questionText = ''
    this.answerText = '' // 問題セットから出題したときの答え（判定結果でのみ配信）
    this.choices = [] // 4択の選択肢（全員に配信する）
    this.plannedCorrect = null // 一斉回答の正解値が事前に分かっている場合（発表に使う）
    this.armedAt = null
    this.presses = [] // { playerId, hostT }
    this.order = []
    this.excluded = new Set()
    this.activePlayerId = null
    this.result = null // { playerId, correct } | null
    // 部屋のルール（host が変更し、state で全員に配信される）
    this.rules = {
      pressSound: 'winner', // 押下音: 'winner'=回答権を得た人だけ / 'all'=押した全員
      nickResume: true, // 切断中の同名プレイヤーへの復帰（得点引き継ぎ）を許可するか
      reveal: 'all', // 問題文の表示: 'all'=一括 / 'serial'=読み上げ（早押し開始で流れる）
      revealCps: 7, // 読み上げ速度（文字/秒）
      correctPoints: 1, // 正解の得点
      wrongPoints: 0, // 誤答の得点（0以下のペナルティ）
      winScore: 0, // 勝ち抜けライン（0=なし。達した人に「勝ち抜け」表示）
      teams: 0, // チーム数（0=個人戦、2〜4）
      answerMode: 'buzzer', // 回答形式: 'buzzer'=早押し / 'ox'=○× / 'choice4'=4択（一斉回答）
      rankBadges: 'top3', // 得点表の順位マーク: 'none'=なし / 'first'=1位に王冠 / 'top3'=上位3人にメダル
      hideScores: false, // 回答者に得点・順位を見せない（結果発表で初めて公開する）
    }
    this.revealBase = 0 // 読み上げの確定位置（文字数）。押下で凍結し、再開放で続きから
    this.answers = new Map() // 一斉回答モードの回答（sessionId → 値。締切まで上書き可）
    this.correctValue = null // 一斉回答モードで発表した正答
    this.lastPingBroadcastAt = 0 // ping 表示更新用の定期配信の絞り
    // このセッションの出題履歴（host UI の「履歴」で表示。部屋の終了とともに消える）
    this.askedLog = [] // { qid, text, answer, winners: [nick], wrongs: [nick], decided }
  }

  get isMassAnswerMode() {
    return this.rules.answerMode !== 'buzzer'
  }

  // ---- 受信メッセージ（検証済みのものだけ渡すこと） ----

  handleMessage(msg, peerId) {
    switch (msg.type) {
      case MSG.HELLO:
        this.#handleHello(msg, peerId)
        break
      case MSG.PONG:
        this.#handlePong(msg, peerId)
        break
      case MSG.BUZZ:
        this.#handleBuzz(msg, peerId)
        break
      case MSG.ANSWER:
        this.#handleAnswer(msg, peerId)
        break
      // host → player 方向の型が届いても無視する
    }
  }

  #handleHello(msg, peerId) {
    if (msg.proto !== PROTO_VERSION) {
      this.send({ type: MSG.REJECTED, reason: 'バージョン不一致。ページを再読み込みしてください' }, peerId)
      return
    }
    // 同じピアが別 sessionId で参加し直した場合は古い紐付けを外す
    const stale = this.#byPeer(peerId)
    if (stale && stale.sessionId !== msg.sessionId) this.#disconnect(stale)

    const requestedNick = msg.nick.trim().slice(0, CONFIG.nickMaxLen)
    let player = this.players.get(msg.sessionId)
    let resumed = player !== undefined
    if (!player && this.rules.nickResume) {
      // タブを閉じる等で sessionId が変わっても、切断中の同名プレイヤーがいれば
      // 同一人物とみなして得点ごと引き継ぐ（接続中のプレイヤーの乗っ取りは不可。
      // ルールで無効化できる）
      const orphan = [...this.players.values()].find((p) => !p.connected && p.nick === requestedNick)
      if (orphan !== undefined) {
        this.#migratePlayerId(orphan.sessionId, msg.sessionId)
        player = orphan
        resumed = true
      }
    }
    if (!player) {
      if (this.players.size >= CONFIG.maxPlayers) {
        this.send({ type: MSG.REJECTED, reason: '満員のため参加できません' }, peerId)
        return
      }
      player = {
        sessionId: msg.sessionId,
        nick: '',
        score: 0,
        handicapMs: 0, // 押下時刻に加算するハンデ（順位判定に反映）
        team: 0, // 所属チーム（0=未所属）
        peerId: null,
        connected: false,
        sync: new PeerSync(),
        pingTimers: [],
        refreshInterval: null,
      }
      this.players.set(msg.sessionId, player)
      this.#autoAssignTeam(player)
    }
    player.nick = requestedNick !== '' ? requestedNick : 'ななし'
    player.peerId = peerId
    player.connected = true
    this.send({ type: MSG.WELCOME, playerId: msg.sessionId, resumed }, peerId)
    this.#startSync(player)
    this.#changed()
  }

  #handlePong(msg, peerId) {
    const player = this.#byPeer(peerId)
    if (!player) return
    if (player.sync.handlePong(msg.seq, msg.t, this.now())) {
      // 定期同期のタイミングで state も配り直す（player の ping 表示の更新と、
      // player 側の「host からの応答が続いているか」の監視を兼ねる。連発しないよう絞る）
      if (this.now() - this.lastPingBroadcastAt > 4000) {
        this.lastPingBroadcastAt = this.now()
        this.send(this.snapshot())
      }
      this.onChange()
    }
  }

  // 一斉回答モードで許される回答値か
  #isValidAnswer(value) {
    if (this.rules.answerMode === 'ox') return value === 'o' || value === 'x'
    if (this.rules.answerMode === 'choice4') return ['1', '2', '3', '4'].includes(value)
    return false
  }

  #handleAnswer(msg, peerId) {
    const player = this.#byPeer(peerId)
    if (!player) return
    if (!this.isMassAnswerMode || this.phase !== PHASE.ARMED) return
    if (msg.qid !== this.qid || !this.#isValidAnswer(msg.value)) return
    this.answers.set(player.sessionId, msg.value) // 締切までは変更可（最後の回答が有効）
    this.#changed()
  }

  #handleBuzz(msg, peerId) {
    const player = this.#byPeer(peerId)
    if (!player) return
    if (this.isMassAnswerMode) return // 一斉回答モードでは早押しを受け付けない
    if (this.phase !== PHASE.ARMED && this.phase !== PHASE.LOCKED) return
    if (msg.qid !== this.qid || this.armedAt === null) return
    if (this.excluded.has(player.sessionId)) return
    if (this.presses.some((p) => p.playerId === player.sessionId)) return
    const offset = player.sync.offset
    if (offset === null) return // 同期前は換算不能（welcome 直後のバーストで通常は即同期済み）
    // ハンデは換算後の押下時刻への加算として順位判定に反映する
    this.presses.push({ playerId: player.sessionId, hostT: toHostTime(msg.t, offset) + player.handicapMs })
    this.#rejudge()
  }

  // 読み上げ（順次表示）の現在位置を確定させる。押下・停止のタイミングで呼ぶ
  #freezeReveal() {
    if (this.rules.reveal !== 'serial' || this.armedAt === null) return
    const elapsedSec = Math.max(0, this.now() - this.armedAt) / 1000
    this.revealBase = Math.min(
      this.questionText.length,
      this.revealBase + this.rules.revealCps * elapsedSec,
    )
  }

  // 押下順を判定し直す。遅れて届いた「実際はより早い押下」も正しく順位に反映される
  #rejudge() {
    const { order } = judgeBuzzes({ armedAt: this.armedAt, presses: this.presses })
    this.order = order
    if (this.phase === PHASE.ARMED && order.length > 0) {
      this.#freezeReveal() // 誰かが押したら読み上げを止める
      this.phase = PHASE.LOCKED
    }
    if (this.phase === PHASE.LOCKED) {
      this.activePlayerId = pickActive(order, this.excluded)
    }
    this.#changed()
  }

  // ---- host の操作 ----

  // 現在の問題の履歴エントリ（qid が一致する最新のもの）
  #logEntry() {
    const entry = this.askedLog[this.askedLog.length - 1]
    return entry !== undefined && entry.qid === this.qid ? entry : null
  }

  // 新しい問題を表示する（RESULT からの「次の問題」もこの操作）
  //   text         : 問題文（空なら口頭で出題）
  //   answer       : 表示用の答え（判定結果で全員に配信。空なら出さない）
  //   choices      : 4択の選択肢（全員に配信）
  //   plannedCorrect: 一斉回答の正解値（'o'|'x'|'1'〜'4'）。分かっていればワンタップで発表できる
  showQuestion({ text = '', answer = '', choices = [], plannedCorrect = null } = {}) {
    this.questionText = text.trim().slice(0, CONFIG.questionMaxLen)
    this.answerText = answer.trim().slice(0, 200)
    this.choices = choices.slice(0, 4).map((c) => String(c).slice(0, 100))
    this.plannedCorrect = this.#isValidAnswer(plannedCorrect) ? plannedCorrect : null
    this.qid += 1
    this.phase = PHASE.QUESTION
    this.armedAt = null
    this.presses = []
    this.order = []
    this.excluded.clear()
    this.activePlayerId = null
    this.result = null
    this.revealBase = 0 // 読み上げは新しい問題の先頭から
    this.answers.clear()
    this.correctValue = null
    this.askedLog.push({ qid: this.qid, text: this.questionText, answer: this.answerText, winners: [], wrongs: [], decided: false })
    if (this.askedLog.length > 200) this.askedLog.shift()
    this.#changed()
  }

  // 表示した問題を引っ込めて出題前に戻す（誤って表示したときの取り消し）。
  // 問題番号と履歴も巻き戻すので、次の出題は同じ番号から始まる
  cancelQuestion() {
    if (this.phase !== PHASE.QUESTION) return
    if (this.#logEntry() !== null) this.askedLog.pop()
    this.qid -= 1
    this.questionText = ''
    this.answerText = ''
    this.choices = []
    this.plannedCorrect = null
    this.revealBase = 0
    this.phase = PHASE.WAITING
    this.#changed()
  }

  // 早押し受付を開始。armedAt（host 時刻）が state に載り、これより前の押下は無効。
  // 順次表示ルールでは読み上げもここから（revealBase の続きから）流れる
  arm() {
    if (this.phase !== PHASE.QUESTION) return
    this.armedAt = this.now()
    this.presses = []
    this.order = []
    this.activePlayerId = null
    this.phase = PHASE.ARMED
    this.#changed()
  }

  // 一斉回答の締め切り（○×・4択）。以後の回答変更を受け付けない
  closeAnswers() {
    if (!this.isMassAnswerMode || this.phase !== PHASE.ARMED) return
    this.#freezeReveal()
    this.phase = PHASE.LOCKED
    this.#changed()
  }

  // 一斉回答の正答を発表して自動採点する
  declareCorrect(value) {
    if (!this.isMassAnswerMode || this.phase !== PHASE.LOCKED) return
    if (!this.#isValidAnswer(value)) return
    this.correctValue = value
    const log = this.#logEntry()
    for (const player of this.players.values()) {
      const answer = this.answers.get(player.sessionId)
      if (answer === undefined) continue // 未回答は増減なし
      player.score += answer === value ? this.rules.correctPoints : this.rules.wrongPoints
      if (log !== null) (answer === value ? log.winners : log.wrongs).push(player.nick)
    }
    if (log !== null) log.decided = true
    this.phase = PHASE.RESULT
    this.revealBase = this.questionText.length
    this.#changed()
  }

  // 受付停止（早押しの仕切り直し。誤答者の除外は維持）。
  // 誤押下のキャンセル手段として、判定待ち（LOCKED）からも戻せる
  stop() {
    if (this.isMassAnswerMode) return
    if (this.phase !== PHASE.ARMED && this.phase !== PHASE.LOCKED) return
    this.#freezeReveal()
    this.phase = PHASE.QUESTION
    this.armedAt = null
    this.presses = []
    this.order = []
    this.activePlayerId = null
    this.#changed()
  }

  judgeCorrect() {
    if (this.phase !== PHASE.LOCKED || this.activePlayerId === null) return
    const player = this.players.get(this.activePlayerId)
    if (player) player.score += this.rules.correctPoints
    const log = this.#logEntry()
    if (log !== null && player !== undefined) {
      log.winners.push(player.nick)
      log.decided = true
    }
    this.result = { playerId: this.activePlayerId, correct: true }
    this.phase = PHASE.RESULT
    this.revealBase = this.questionText.length // 決着したので問題文を全文表示する
    this.#changed()
  }

  // 誤答ペナルティ（ルールで 0 以下の得点を設定できる）。履歴にも誤答者として記録する
  #applyWrongPenalty(playerId) {
    const player = this.players.get(playerId)
    if (!player) return
    player.score += this.rules.wrongPoints
    const log = this.#logEntry()
    if (log !== null && !log.wrongs.includes(player.nick)) log.wrongs.push(player.nick)
  }

  // 不正解: 次点者に権利を回す
  judgeWrongNext() {
    if (this.phase !== PHASE.LOCKED || this.activePlayerId === null) return
    this.#applyWrongPenalty(this.activePlayerId)
    this.excluded.add(this.activePlayerId)
    const next = pickActive(this.order, this.excluded)
    if (next !== null) {
      this.activePlayerId = next
    } else {
      // 次点がいない: 正解者なしで結果表示へ
      this.result = { playerId: null, correct: false }
      const log = this.#logEntry()
      if (log !== null) log.decided = true
      this.activePlayerId = null
      this.phase = PHASE.RESULT
      this.revealBase = this.questionText.length // 決着したので問題文を全文表示する
    }
    this.#changed()
  }

  // 不正解: 全員に再開放（誤答者は除外）
  judgeWrongReopen() {
    if (this.phase !== PHASE.LOCKED || this.activePlayerId === null) return
    this.#applyWrongPenalty(this.activePlayerId)
    this.excluded.add(this.activePlayerId)
    this.#reopen()
  }

  // 不正解: 誤答者のチーム全員を除外して他チームに開放（チーム戦のみ）
  judgeWrongOpenOtherTeams() {
    if (this.phase !== PHASE.LOCKED || this.activePlayerId === null) return
    if (this.rules.teams === 0) return
    const wrongPlayer = this.players.get(this.activePlayerId)
    if (!wrongPlayer) return
    this.#applyWrongPenalty(this.activePlayerId)
    for (const player of this.players.values()) {
      if (player.team === wrongPlayer.team) this.excluded.add(player.sessionId)
    }
    this.#reopen()
  }

  #reopen() {
    this.presses = []
    this.order = []
    this.activePlayerId = null
    this.armedAt = this.now()
    this.phase = PHASE.ARMED
    this.#changed()
  }

  // ---- 結果発表 ----

  finishGame() {
    if (this.phase === PHASE.FINAL) return
    this.phase = PHASE.FINAL
    this.#changed()
  }

  resumeGame() {
    if (this.phase !== PHASE.FINAL) return
    this.phase = PHASE.WAITING
    this.#changed()
  }

  resetScores() {
    for (const player of this.players.values()) player.score = 0
    if (this.phase === PHASE.FINAL) this.phase = PHASE.WAITING
    this.#changed()
  }

  // 手動加減点
  adjustScore(playerId, delta) {
    const player = this.players.get(playerId)
    if (!player) return
    player.score += delta
    this.#changed()
  }

  // ---- ルール設定 ----

  setPressSound(value) {
    if (value !== 'winner' && value !== 'all') return
    this.rules.pressSound = value
    this.#changed()
  }

  setNickResume(value) {
    if (typeof value !== 'boolean') return
    this.rules.nickResume = value
    this.#changed()
  }

  setReveal(value) {
    if (value !== 'all' && value !== 'serial') return
    this.rules.reveal = value
    this.#changed()
  }

  setRankBadges(value) {
    if (!['none', 'first', 'top3'].includes(value)) return
    this.rules.rankBadges = value
    this.#changed()
  }

  setHideScores(value) {
    this.rules.hideScores = Boolean(value)
    this.#changed()
  }

  setRevealCps(value) {
    const cps = Number(value)
    if (![4, 7, 12].includes(cps)) return // ゆっくり/ふつう/はやい
    this.rules.revealCps = cps
    this.#changed()
  }

  setCorrectPoints(value) {
    const points = Number(value)
    if (![1, 2, 3, 5, 10].includes(points)) return
    this.rules.correctPoints = points
    this.#changed()
  }

  setWrongPoints(value) {
    const points = Number(value)
    if (![0, -1, -2, -5].includes(points)) return
    this.rules.wrongPoints = points
    this.#changed()
  }

  setWinScore(value) {
    const score = Number(value)
    if (![0, 5, 7, 10].includes(score)) return
    this.rules.winScore = score
    this.#changed()
  }

  // ---- チーム ----

  setAnswerMode(value) {
    if (!['buzzer', 'ox', 'choice4'].includes(value)) return
    this.rules.answerMode = value
    this.#changed()
  }

  setTeams(value) {
    const count = Number(value)
    if (![0, 2, 3, 4].includes(count)) return
    this.rules.teams = count
    // 参加順で均等に割り直す（0 なら個人戦に戻す）
    let index = 0
    for (const player of this.players.values()) {
      player.team = count === 0 ? 0 : (index % count) + 1
      index += 1
    }
    this.#changed()
  }

  cycleTeam(playerId) {
    if (this.rules.teams === 0) return
    const player = this.players.get(playerId)
    if (!player) return
    player.team = (player.team % this.rules.teams) + 1
    this.#changed()
  }

  shuffleTeams() {
    if (this.rules.teams === 0) return
    const players = [...this.players.values()]
    for (let i = players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[players[i], players[j]] = [players[j], players[i]]
    }
    players.forEach((player, index) => {
      player.team = (index % this.rules.teams) + 1
    })
    this.#changed()
  }

  // 途中参加者は人数が最少のチームへ入れる
  #autoAssignTeam(player) {
    if (this.rules.teams === 0) return
    const counts = new Array(this.rules.teams + 1).fill(0)
    for (const p of this.players.values()) {
      if (p.team >= 1) counts[p.team] += 1
    }
    counts[player.team] -= 1 // 自分自身は数えない
    let best = 1
    for (let team = 2; team <= this.rules.teams; team++) {
      if (counts[team] < counts[best]) best = team
    }
    player.team = best
  }

  setHandicap(playerId, ms) {
    const player = this.players.get(playerId)
    if (!player) return
    const value = Number(ms)
    if (!Number.isFinite(value)) return
    player.handicapMs = Math.max(0, Math.min(10000, Math.round(value)))
    this.#changed()
  }

  handlePeerLeave(peerId) {
    const player = this.#byPeer(peerId)
    if (!player) return
    this.#disconnect(player)
    this.#changed()
  }

  destroy() {
    for (const player of this.players.values()) this.#stopSync(player)
  }

  // ---- 時刻同期（ping 送信のスケジューリング） ----

  #startSync(player) {
    this.#stopSync(player)
    // 接続直後のバースト
    for (let i = 0; i < CONFIG.sync.burstCount; i++) {
      player.pingTimers.push(setTimeout(() => this.#sendPing(player), i * CONFIG.sync.burstIntervalMs))
    }
    // 以後は定期的に少数サンプルで再同期（クロックドリフト対策）
    player.refreshInterval = setInterval(() => {
      for (let i = 0; i < CONFIG.sync.refreshCount; i++) {
        player.pingTimers.push(setTimeout(() => this.#sendPing(player), i * CONFIG.sync.burstIntervalMs))
      }
    }, CONFIG.sync.refreshIntervalMs)
  }

  #stopSync(player) {
    for (const timer of player.pingTimers) clearTimeout(timer)
    player.pingTimers = []
    if (player.refreshInterval !== null) {
      clearInterval(player.refreshInterval)
      player.refreshInterval = null
    }
  }

  #sendPing(player) {
    if (!player.connected || player.peerId === null) return
    const seq = player.sync.beginPing(this.now())
    this.send({ type: MSG.PING, seq }, player.peerId)
  }

  // ---- 内部 ----

  // プレイヤーIDを新しい sessionId に付け替える（進行中の状態の参照もすべて更新）
  #migratePlayerId(oldId, newId) {
    const player = this.players.get(oldId)
    this.players.delete(oldId)
    player.sessionId = newId
    this.players.set(newId, player)
    for (const press of this.presses) {
      if (press.playerId === oldId) press.playerId = newId
    }
    this.order = this.order.map((o) => (o.playerId === oldId ? { ...o, playerId: newId } : o))
    if (this.excluded.delete(oldId)) this.excluded.add(newId)
    if (this.activePlayerId === oldId) this.activePlayerId = newId
    if (this.result !== null && this.result.playerId === oldId) {
      this.result = { ...this.result, playerId: newId }
    }
  }

  #byPeer(peerId) {
    for (const player of this.players.values()) {
      if (player.connected && player.peerId === peerId) return player
    }
    return null
  }

  #disconnect(player) {
    player.connected = false
    player.peerId = null
    this.#stopSync(player)
  }

  // 全 player へ配信する状態スナップショット
  snapshot() {
    return {
      type: MSG.STATE,
      phase: this.phase,
      qid: this.qid,
      questionText: this.questionText,
      armedAt: this.armedAt,
      players: [...this.players.values()].map((p) => ({
        playerId: p.sessionId,
        nick: p.nick,
        score: p.score,
        connected: p.connected,
        handicapMs: p.handicapMs,
        team: p.team,
        rttMs: p.sync.rtt === null ? null : Math.round(p.sync.rtt),
      })),
      order: this.order.map((o) => ({
        playerId: o.playerId,
        deltaMs: Math.round(o.deltaMs * 10) / 10, // 表示用に 0.1ms 精度へ丸める
      })),
      activePlayerId: this.activePlayerId,
      excluded: [...this.excluded],
      result: this.result,
      rules: { ...this.rules },
      revealBase: Math.round(this.revealBase * 10) / 10,
      answeredIds: [...this.answers.keys()],
      revealedAnswers:
        this.isMassAnswerMode && (this.phase === PHASE.LOCKED || this.phase === PHASE.RESULT)
          ? [...this.answers.entries()].map(([playerId, value]) => ({ playerId, value }))
          : null, // 締切までは回答内容を配信しない（覗き見・コピー防止）
      correctValue: this.correctValue,
      // 答えは判定結果になって初めて配信する（受付中に配ると開発者ツールで覗ける）
      answerText: this.phase === PHASE.RESULT && this.answerText !== '' ? this.answerText : null,
      choices: [...this.choices],
    }
  }

  #changed() {
    this.send(this.snapshot()) // 全 player へブロードキャスト
    this.onChange()
  }
}
