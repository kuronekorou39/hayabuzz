import { CONFIG } from '../config.js'
import { diagLog } from './diag.js'

// WebTorrent トラッカーの WebSocket プロトコルを話すシグナリングクライアント。
//
// トラッカーは本来 BitTorrent のピア発見用だが、WebSocket 版のプロトコルは
// announce メッセージに WebRTC の offer を相乗りさせると、同じ info_hash に
// announce している他のピアへ転送してくれる（answer も同様に転送される）。
// これを「接続情報の掲示板」として使う。転送されるのは SDP テキストのみで、
// 接続確立後のゲームデータは一切トラッカーを通らない。
//
// メッセージ形式（すべて JSON テキスト）:
//   自分 → トラッカー: { action:'announce', info_hash, peer_id, numwant,
//                        offers:[{ offer_id, offer:{type:'offer', sdp} }] }
//   トラッカー → 相手:  { action:'announce', info_hash, peer_id(=送信元), offer_id, offer }
//   相手 → トラッカー:  { action:'announce', info_hash, peer_id, to_peer_id, offer_id,
//                        answer:{type:'answer', sdp} }
export class TrackerSignal {
  constructor({ urls, infoHash, peerId, onRemoteOffer, onRemoteAnswer }) {
    this.urls = urls
    this.infoHash = infoHash
    this.peerId = peerId
    this.onRemoteOffer = onRemoteOffer // (offerDesc, fromPeerId, respond(answerDesc)) => void
    this.onRemoteAnswer = onRemoteAnswer // (offerId, answerDesc, fromPeerId) => void
    this.getOffers = null
    this.sockets = new Map() // url -> WebSocket
    this.timers = new Map() // url -> announce interval
    this.retryDelays = new Map() // url -> 次回再接続までのms
    this.handledSignals = new Map() // 重複排除（同じ offer/answer が複数トラッカー経由で届く）
    this.announceQueued = false
    this.active = false
  }

  // getOffers: async (n) => [{ offerId, sdp }] 現在有効な offer プールを返す
  start(getOffers) {
    this.getOffers = getOffers
    this.active = true
    for (const url of this.urls) this.#connect(url)
  }

  stop() {
    this.active = false
    for (const timer of this.timers.values()) clearInterval(timer)
    this.timers.clear()
    for (const socket of this.sockets.values()) {
      socket.onclose = null
      socket.close()
    }
    this.sockets.clear()
  }

  // offer プールが変化したとき等に、次の周期を待たず全トラッカーへ再 announce する
  requestAnnounce() {
    if (!this.active || this.announceQueued) return
    this.announceQueued = true
    setTimeout(() => {
      this.announceQueued = false
      for (const url of this.sockets.keys()) this.#announce(url)
    }, 300) // 連続消費をまとめるデバウンス
  }

  #connect(url) {
    if (!this.active) return
    const shortHost = url.replace('wss://', '').split('/')[0]
    let socket
    try {
      socket = new WebSocket(url)
    } catch (err) {
      diagLog('トラッカー接続不可', `${shortHost} ${err.message}`)
      this.#scheduleReconnect(url)
      return
    }
    this.sockets.set(url, socket)
    socket.onopen = () => {
      diagLog('トラッカー接続', shortHost)
      this.retryDelays.delete(url)
      this.#announce(url)
      const timer = setInterval(() => this.#announce(url), CONFIG.signaling.announceIntervalMs)
      this.timers.set(url, timer)
    }
    socket.onmessage = (ev) => this.#handleMessage(url, ev.data)
    socket.onclose = () => {
      diagLog('トラッカー切断', shortHost)
      const timer = this.timers.get(url)
      if (timer !== undefined) clearInterval(timer)
      this.timers.delete(url)
      this.sockets.delete(url)
      this.#scheduleReconnect(url)
    }
    socket.onerror = () => {} // 実際の後始末は onclose 側で行う
  }

  #scheduleReconnect(url) {
    if (!this.active) return
    const delay = this.retryDelays.get(url) ?? CONFIG.signaling.reconnectBaseMs
    this.retryDelays.set(url, Math.min(delay * 2, CONFIG.signaling.reconnectMaxMs))
    setTimeout(() => this.#connect(url), delay)
  }

  async #announce(url) {
    const socket = this.sockets.get(url)
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const offers = await this.getOffers()
    this.#send(url, {
      numwant: CONFIG.signaling.numwant,
      offers: offers.map((o) => ({
        offer_id: o.offerId,
        offer: { type: 'offer', sdp: o.sdp },
      })),
    })
  }

  #send(url, payload) {
    const socket = this.sockets.get(url)
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(
      JSON.stringify({
        action: 'announce',
        info_hash: this.infoHash,
        peer_id: this.peerId,
        ...payload,
      }),
    )
  }

  #handleMessage(url, raw) {
    if (typeof raw !== 'string' || raw.length > 65536) return
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof data !== 'object' || data === null) return
    if (typeof data['failure reason'] === 'string') {
      diagLog('トラッカー拒否', data['failure reason'])
      return
    }
    if (data.info_hash !== undefined && data.info_hash !== this.infoHash) return
    if (data.peer_id === this.peerId) return // 自分の announce の跳ね返り

    const hasOffer = typeof data.offer?.sdp === 'string'
    const hasAnswer = typeof data.answer?.sdp === 'string'
    if ((!hasOffer && !hasAnswer) || typeof data.offer_id !== 'string' || typeof data.peer_id !== 'string') {
      return // 通常の announce 応答（interval等）は無視してよい
    }

    // 同じシグナルが複数トラッカー経由で届くので短い時間窓で重複排除する
    const key = `${hasOffer ? 'o' : 'a'}:${data.offer_id}:${data.peer_id}`
    const now = Date.now()
    const last = this.handledSignals.get(key)
    if (last !== undefined && now - last < CONFIG.signaling.dedupeWindowMs) return
    this.handledSignals.set(key, now)
    for (const [k, at] of this.handledSignals) {
      if (now - at > CONFIG.signaling.dedupeWindowMs * 6) this.handledSignals.delete(k)
    }

    if (hasOffer) {
      diagLog('offer受信', data.peer_id.slice(0, 4))
      // answer は offer が届いたのと同じトラッカー経由で返す
      const respond = (answerDesc) => {
        diagLog('answer送信', data.peer_id.slice(0, 4))
        this.#send(url, {
          to_peer_id: data.peer_id,
          offer_id: data.offer_id,
          answer: { type: 'answer', sdp: answerDesc.sdp },
        })
      }
      this.onRemoteOffer(data.offer, data.peer_id, respond)
    } else {
      diagLog('answer受信', data.peer_id.slice(0, 4))
      this.onRemoteAnswer(data.offer_id, data.answer, data.peer_id)
    }
  }
}
