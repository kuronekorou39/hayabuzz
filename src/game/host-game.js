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
    this.armedAt = null
    this.presses = [] // { playerId, hostT }
    this.order = []
    this.excluded = new Set()
    this.activePlayerId = null
    this.result = null // { playerId, correct } | null
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

    let player = this.players.get(msg.sessionId)
    const resumed = player !== undefined
    if (!player) {
      if (this.players.size >= CONFIG.maxPlayers) {
        this.send({ type: MSG.REJECTED, reason: '満員のため参加できません' }, peerId)
        return
      }
      player = {
        sessionId: msg.sessionId,
        nick: '',
        score: 0,
        peerId: null,
        connected: false,
        sync: new PeerSync(),
        pingTimers: [],
        refreshInterval: null,
      }
      this.players.set(msg.sessionId, player)
    }
    const nick = msg.nick.trim().slice(0, CONFIG.nickMaxLen)
    player.nick = nick !== '' ? nick : 'ななし'
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
      // 同期状態はプロトコル状態に含まれないため、host UI の再描画のみ
      this.onChange()
    }
  }

  #handleBuzz(msg, peerId) {
    const player = this.#byPeer(peerId)
    if (!player) return
    if (this.phase !== PHASE.ARMED && this.phase !== PHASE.LOCKED) return
    if (msg.qid !== this.qid || this.armedAt === null) return
    if (this.excluded.has(player.sessionId)) return
    if (this.presses.some((p) => p.playerId === player.sessionId)) return
    const offset = player.sync.offset
    if (offset === null) return // 同期前は換算不能（welcome 直後のバーストで通常は即同期済み）
    this.presses.push({ playerId: player.sessionId, hostT: toHostTime(msg.t, offset) })
    this.#rejudge()
  }

  // 押下順を判定し直す。遅れて届いた「実際はより早い押下」も正しく順位に反映される
  #rejudge() {
    const { order } = judgeBuzzes({ armedAt: this.armedAt, presses: this.presses })
    this.order = order
    if (this.phase === PHASE.ARMED && order.length > 0) this.phase = PHASE.LOCKED
    if (this.phase === PHASE.LOCKED) {
      this.activePlayerId = pickActive(order, this.excluded)
    }
    this.#changed()
  }

  // ---- host の操作 ----

  // 新しい問題を表示する（RESULT からの「次の問題」もこの操作）
  showQuestion(text) {
    this.questionText = text.trim().slice(0, CONFIG.questionMaxLen)
    this.qid += 1
    this.phase = PHASE.QUESTION
    this.armedAt = null
    this.presses = []
    this.order = []
    this.excluded.clear()
    this.activePlayerId = null
    this.result = null
    this.#changed()
  }

  // 早押し受付を開始。armedAt（host 時刻）が state に載り、これより前の押下は無効
  arm() {
    if (this.phase !== PHASE.QUESTION) return
    this.armedAt = this.now()
    this.presses = []
    this.order = []
    this.activePlayerId = null
    this.phase = PHASE.ARMED
    this.#changed()
  }

  // 受付停止（仕切り直し。誤答者の除外は維持）
  stop() {
    if (this.phase !== PHASE.ARMED) return
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
    if (player) player.score += 1
    this.result = { playerId: this.activePlayerId, correct: true }
    this.phase = PHASE.RESULT
    this.#changed()
  }

  // 不正解: 次点者に権利を回す
  judgeWrongNext() {
    if (this.phase !== PHASE.LOCKED || this.activePlayerId === null) return
    this.excluded.add(this.activePlayerId)
    const next = pickActive(this.order, this.excluded)
    if (next !== null) {
      this.activePlayerId = next
    } else {
      // 次点がいない: 正解者なしで結果表示へ
      this.result = { playerId: null, correct: false }
      this.activePlayerId = null
      this.phase = PHASE.RESULT
    }
    this.#changed()
  }

  // 不正解: 全員に再開放（誤答者は除外）
  judgeWrongReopen() {
    if (this.phase !== PHASE.LOCKED || this.activePlayerId === null) return
    this.excluded.add(this.activePlayerId)
    this.presses = []
    this.order = []
    this.activePlayerId = null
    this.armedAt = this.now()
    this.phase = PHASE.ARMED
    this.#changed()
  }

  // 手動加減点
  adjustScore(playerId, delta) {
    const player = this.players.get(playerId)
    if (!player) return
    player.score += delta
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
      })),
      order: this.order.map((o) => ({
        playerId: o.playerId,
        deltaMs: Math.round(o.deltaMs * 10) / 10, // 表示用に 0.1ms 精度へ丸める
      })),
      activePlayerId: this.activePlayerId,
      excluded: [...this.excluded],
      result: this.result,
    }
  }

  #changed() {
    this.send(this.snapshot()) // 全 player へブロードキャスト
    this.onChange()
  }
}
