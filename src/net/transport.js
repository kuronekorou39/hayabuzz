import { createTrysteroTransport } from './trystero.js'

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
// Trystero が不安定な場合は、この契約を満たす PeerJS 実装
// （createPeerjsTransport 等）を追加し、下の分岐に登録して差し替える。
export function createTransport(kind = 'trystero') {
  switch (kind) {
    case 'trystero':
      return createTrysteroTransport()
    default:
      throw new Error(`unknown transport: ${kind}`)
  }
}
