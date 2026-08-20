import { createWebrtcTransport } from './webrtc-transport.js'

// 通信層の共通インターフェース。実装は以下の契約を満たすこと:
//
//   {
//     selfId: string                       // 自分のピアID
//     join(roomId): Promise<void>          // 部屋に参加（シグナリング開始）
//     leave(): void                        // 退室
//     send(msg, peerId?): void             // peerId 省略時は全ピアへブロードキャスト
//     onMessage(cb(msg, peerId)): void     // メッセージ受信
//     onPeerJoin(cb(peerId)): void         // ピア接続確立
//     onPeerLeave(cb(peerId)): void        // ピア切断
//   }
//
// 現在の実装は自前の WebRTC + WebTorrent トラッカーシグナリング
// （webrtc-transport.js / tracker-signal.js）。別方式に差し替える場合は
// この契約を満たす実装を追加してここで切り替える。
export function createTransport({ role }) {
  return createWebrtcTransport({ role })
}
