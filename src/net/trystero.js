import { joinRoom, selfId } from '@trystero-p2p/torrent'
import { CONFIG } from '../config.js'

// transport.js のインターフェースを Trystero（BitTorrent トラッカー方式）で実装する。
// シグナリングは公開トラッカー経由・アカウント不要。以降の通信は WebRTC DataChannel。
export function createTrysteroTransport() {
  let room = null
  let sendAction = null
  const messageHandlers = []
  const joinHandlers = []
  const leaveHandlers = []

  return {
    selfId,

    join(roomId) {
      room = joinRoom(
        { appId: CONFIG.appId, rtcConfig: { iceServers: CONFIG.iceServers } },
        roomId,
      )
      const action = room.makeAction('msg')
      action.onMessage = (data, { peerId }) => {
        for (const handler of messageHandlers) handler(data, peerId)
      }
      sendAction = action.send
      room.onPeerJoin = (peerId) => {
        for (const handler of joinHandlers) handler(peerId)
      }
      room.onPeerLeave = (peerId) => {
        for (const handler of leaveHandlers) handler(peerId)
      }
      // joinRoom は同期的に部屋を返す（トラッカー接続はバックグラウンドで進む）。
      // ピア到達の待ち合わせは呼び出し側が onPeerJoin + タイムアウトで行う。
      return Promise.resolve()
    },

    leave() {
      room?.leave()
      room = null
      sendAction = null
    },

    send(msg, peerId) {
      if (!sendAction) return
      // 切断直後のピアへの送信失敗は無視する（状態は次のスナップショットで回復する）
      sendAction(msg, peerId ? { target: peerId } : undefined).catch(() => {})
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
