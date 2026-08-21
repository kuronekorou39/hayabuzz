import { CONFIG } from '../config.js'
import { randomCode } from '../util/random.js'
import { diagLog } from './diag.js'
import { TrackerSignal } from './tracker-signal.js'

// transport.js のインターフェースの自前実装。
// シグナリングは tracker-signal.js（WebTorrent トラッカー）、
// 接続は RTCPeerConnection + DataChannel を直接扱う。
//
// トポロジは WebRTC レベルでもスター型に強制する:
//   - peer_id の先頭に役割を埋め込む（HBH-*=host / HBP-*=player）
//   - player は host の offer にしか answer しない（player どうしは接続しない）
//   - host は player の offer にのみ answer する
// 参加を速くするため、host と player の両方が offer を announce する（双方向 offer）。
// 同じ相手と両方向で接続が成立した場合は「offer を出した側の peer_id が小さい方を残す」
// 決定的ルールで片方を閉じる（両端で同じ結論になる）。

const ROLE_PREFIX = { host: 'HBH-', player: 'HBP-' }
const PENDING_ANSWER_TTL_MS = 30000

// 旧 WebKit（iOS 12 等）は setRemoteDescription に RTCSessionDescription の
// インスタンスを要求するため、素のオブジェクトを包んで渡す
function toSessionDescription(desc) {
  return typeof RTCSessionDescription === 'function' ? new RTCSessionDescription(desc) : desc
}

async function sha1Hex(text) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  let hex = ''
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

// ICE 候補の収集完了を待つ（トラッカー経由では候補を後送りできないため SDP に同梱する）。
// 遅い環境で待ち続けないよう上限時間で打ち切る
function waitIceGathering(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve()
      return
    }
    const timer = setTimeout(finish, CONFIG.signaling.iceGatherTimeoutMs)
    function finish() {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    function check() {
      if (pc.iceGatheringState === 'complete') finish()
    }
    pc.addEventListener('icegatheringstatechange', check)
  })
}

export function createWebrtcTransport({ role }) {
  const prefix = ROLE_PREFIX[role]
  if (prefix === undefined) throw new Error(`unknown role: ${role}`)
  const selfId = prefix + randomCode(16)
  const remoteRolePrefix = role === 'host' ? ROLE_PREFIX.player : ROLE_PREFIX.host

  const messageHandlers = []
  const joinHandlers = []
  const leaveHandlers = []

  let signal = null
  let active = false
  const offerPool = new Map() // offerId -> { pc, channel, sdp, createdAt } 接続待ち受け枠
  const pendingAnswers = new Set() // 自分が answer を返し確立待ちの { pc, createdAt, gotChannel }
  const peers = new Map() // remotePeerId -> { pc, channel, offererId }

  function newPeerConnection() {
    return new RTCPeerConnection({ iceServers: CONFIG.iceServers })
  }

  // 収集できた ICE 候補の種別を診断ログに残す（mDNS 混入や TURN の生死が分かる）
  function logCandidates(pc, label) {
    const sdp = pc.localDescription !== null ? pc.localDescription.sdp : ''
    const lines = sdp.split('\n').filter((line) => line.startsWith('a=candidate'))
    const count = (type) => lines.filter((line) => line.includes(`typ ${type}`)).length
    const mdns = lines.filter((line) => line.includes('.local')).length
    diagLog('候補', `${label} host=${count('host')}(mDNS ${mdns}) srflx=${count('srflx')} relay=${count('relay')}`)
  }

  // 相手が確定した接続にイベントを配線する。
  // conn オブジェクトはここで1つだけ作る（open 済みで届いた場合と open イベントの
  // 両方から registerPeer が呼ばれても、同一接続と判定できるようにするため）
  function wireConnection(pc, channel, remoteId, offererId) {
    const conn = { pc, channel, offererId }
    const onOpen = () => registerPeer(remoteId, conn)
    if (channel.readyState === 'open') onOpen()
    else channel.addEventListener('open', onOpen)
    channel.addEventListener('close', () => {
      unregisterPeer(remoteId, channel)
    })
    // 相手プロセスの突然死（タブ強制終了等）は close イベントが飛んでこないため、
    // ICE の disconnected を猶予付きで切断とみなす（復帰したら取り消す）
    let disconnectTimer = null
    pc.addEventListener('iceconnectionstatechange', () => {
      const state = pc.iceConnectionState
      if (state === 'disconnected') {
        if (disconnectTimer === null) {
          disconnectTimer = setTimeout(() => unregisterPeer(remoteId, channel), 5000)
        }
      } else if (state === 'connected' || state === 'completed') {
        if (disconnectTimer !== null) {
          clearTimeout(disconnectTimer)
          disconnectTimer = null
        }
      }
    })
    channel.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string' || ev.data.length > 262144) return
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      for (const handler of messageHandlers) handler(msg, remoteId)
    })
    pc.addEventListener('iceconnectionstatechange', () => {
      diagLog('ICE', `${remoteId.slice(0, 4)} ${pc.iceConnectionState}`)
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        unregisterPeer(remoteId, channel)
      }
    })
  }

  function registerPeer(remoteId, conn) {
    if (!active) {
      conn.pc.close()
      return
    }
    const existing = peers.get(remoteId)
    if (existing !== undefined) {
      if (existing.channel === conn.channel) return // 同一接続の再登録（何もしない）
      // 双方向 offer で二重に確立した場合の決定的な重複解決
      const keepNew = conn.offererId < existing.offererId
      const loser = keepNew ? existing : conn
      const winner = keepNew ? conn : existing
      peers.set(remoteId, winner)
      loser.channel.close()
      loser.pc.close()
      return // onPeerJoin は既に発火済み
    }
    peers.set(remoteId, conn)
    diagLog('ピア接続', remoteId.slice(0, 4))
    for (const handler of joinHandlers) handler(remoteId)
  }

  function unregisterPeer(remoteId, channel) {
    const current = peers.get(remoteId)
    if (current === undefined || current.channel !== channel) return // 重複解決で閉じた側の後始末
    peers.delete(remoteId)
    current.pc.close()
    for (const handler of leaveHandlers) handler(remoteId)
  }

  // --- offer プール（announce に載せる接続待ち受け枠） ---

  async function createPoolOffer() {
    try {
      const pc = newPeerConnection()
      const channel = pc.createDataChannel('data')
      const offerId = randomCode(20)
      await pc.setLocalDescription(await pc.createOffer())
      await waitIceGathering(pc)
      logCandidates(pc, 'offer')
      offerPool.set(offerId, { pc, channel, sdp: pc.localDescription.sdp, createdAt: Date.now() })
    } catch (err) {
      diagLog('offer作成エラー', err.message)
      throw err
    }
  }

  async function getOffers() {
    if (!active) return []
    const now = Date.now()
    // 古い offer は ICE 候補が失効しうるので作り直す
    for (const [offerId, entry] of offerPool) {
      if (now - entry.createdAt > CONFIG.signaling.offerTtlMs) {
        offerPool.delete(offerId)
        entry.pc.close()
      }
    }
    // 確立に至らなかった answer 側の接続も掃除する
    for (const pending of [...pendingAnswers]) {
      if (!pending.gotChannel && now - pending.createdAt > PENDING_ANSWER_TTL_MS) {
        pendingAnswers.delete(pending)
        pending.pc.close()
      }
    }
    while (offerPool.size < CONFIG.signaling.offerPool) {
      await createPoolOffer()
    }
    return [...offerPool.entries()].map(([offerId, entry]) => ({ offerId, sdp: entry.sdp }))
  }

  // --- シグナル処理 ---

  const lastAnsweredAt = new Map() // remotePeerId -> 最後に answer を返した時刻（連打抑制）

  async function handleRemoteOffer(offerDesc, fromPeerId, respond) {
    if (!active) return
    if (!fromPeerId.startsWith(remoteRolePrefix)) return // スター型: 想定した役割の相手以外は無視
    const existing = peers.get(fromPeerId)
    if (existing !== undefined && existing.channel.readyState === 'open') return // 接続済み
    // 同じ相手の複数 offer に片っ端から answer すると並列接続が乱立するため、
    // 確立待ちの間は少し空ける（失敗時は次の offer で再試行される）
    const last = lastAnsweredAt.get(fromPeerId)
    const now = Date.now()
    if (last !== undefined && now - last < 5000) return
    lastAnsweredAt.set(fromPeerId, now)
    const pc = newPeerConnection()
    const pending = { pc, createdAt: now, gotChannel: false }
    pendingAnswers.add(pending)
    pc.addEventListener('datachannel', (ev) => {
      pending.gotChannel = true
      pendingAnswers.delete(pending)
      wireConnection(pc, ev.channel, fromPeerId, fromPeerId) // open 済みで届くケースも wireConnection 内で処理される
    })
    try {
      await pc.setRemoteDescription(toSessionDescription(offerDesc))
      await pc.setLocalDescription(await pc.createAnswer())
      await waitIceGathering(pc)
      logCandidates(pc, 'answer')
      respond(pc.localDescription)
    } catch (err) {
      diagLog('offer処理エラー', err.message)
      pendingAnswers.delete(pending)
      pc.close()
    }
  }

  async function handleRemoteAnswer(offerId, answerDesc, fromPeerId) {
    if (!active) return
    if (!fromPeerId.startsWith(remoteRolePrefix)) return
    const entry = offerPool.get(offerId)
    if (entry === undefined || entry.pc.signalingState !== 'have-local-offer') return
    offerPool.delete(offerId) // この offer は消費された
    wireConnection(entry.pc, entry.channel, fromPeerId, selfId)
    try {
      await entry.pc.setRemoteDescription(toSessionDescription(answerDesc))
    } catch (err) {
      diagLog('answer適用エラー', err.message)
      entry.pc.close()
      return
    }
    signal?.requestAnnounce() // プールを補充して次の参加に備える
  }

  // 旧端末互換モード: マイク使用許可を一度取ると Chrome 等が ICE 候補に
  // 実 IP を含めるようになり（mDNS の .local 名を解決できない iOS 12 等の
  // 旧 WebRTC でも）同一 LAN で直結できるようになる。音声は一切使わない
  async function enableLegacyCompat() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    for (const track of stream.getTracks()) track.stop()
    diagLog('互換モード', 'マイク許可OK（実IP候補が有効）')
    // 既存の待ち受け offer は mDNS 候補のままなので作り直す
    for (const entry of offerPool.values()) entry.pc.close()
    offerPool.clear()
    signal?.requestAnnounce()
  }

  return {
    selfId,
    enableLegacyCompat,

    async join(roomId) {
      active = true
      try {
        diagLog('参加開始', `role=${role}`)
        // 部屋のトピックをハッシュ化してトラッカーの info_hash（20文字）にする
        const infoHash = (await sha1Hex(`${CONFIG.appId}/${roomId}`)).slice(0, 20)
        signal = new TrackerSignal({
          urls: CONFIG.signaling.trackerUrls,
          infoHash,
          peerId: selfId,
          onRemoteOffer: handleRemoteOffer,
          onRemoteAnswer: handleRemoteAnswer,
        })
        signal.start(getOffers)
      } catch (err) {
        diagLog('参加処理エラー', err.message)
        throw err
      }
    },

    leave() {
      active = false
      signal?.stop()
      signal = null
      for (const entry of offerPool.values()) entry.pc.close()
      offerPool.clear()
      for (const pending of pendingAnswers) pending.pc.close()
      pendingAnswers.clear()
      for (const conn of peers.values()) conn.pc.close()
      peers.clear()
    },

    send(msg, peerId) {
      const text = JSON.stringify(msg)
      const targets = peerId !== undefined && peerId !== null ? [peers.get(peerId)] : [...peers.values()]
      for (const conn of targets) {
        if (conn !== undefined && conn.channel.readyState === 'open') {
          try {
            conn.channel.send(text)
          } catch {
            // 切断直後の送信失敗は無視する（状態は次のスナップショットで回復する）
          }
        }
      }
    },

    onMessage(handler) {
      messageHandlers.push(handler)
    },
    onPeerJoin(handler) {
      joinHandlers.push(handler)
    },
    onPeerLeave(handler) {
      leaveHandlers.push(handler)
    },
  }
}
