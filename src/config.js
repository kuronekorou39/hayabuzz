// 運用で調整しうる値をここに集約する
export const CONFIG = {
  // 通信
  appId: 'hayabuzz-v1', // Trystero のアプリ識別子（部屋名の名前空間）
  joinTimeoutMs: 15000, // 参加確立（welcome受信）までの待ち時間
  maxPlayers: 24,

  // WebRTC の経路確立（ICE）設定。
  // STUN を複数指定して経路発見を安定させ、直結できない回線（対称NAT・
  // キャリア回線・iCloudプライベートリレー等）向けに TURN 中継をフォールバックに置く。
  // 下の TURN はコミュニティ提供のベストエフォート（Open Relay）。
  // 安定運用したい場合は自前の TURN サーバに差し替えること
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],

  // 時刻同期（ping/pong）
  sync: {
    burstCount: 8, // 接続直後の連続サンプル数
    burstIntervalMs: 150,
    refreshCount: 3, // 定期再同期のサンプル数
    refreshIntervalMs: 10000,
    windowSize: 9, // オフセット中央値を取るスライディングウィンドウ長
  },

  // 入力制限（プロトコル検証と UI の maxlength で共用）
  nickMaxLen: 20,
  questionMaxLen: 500,
  roomCodeLen: 10,
  sessionIdLen: 16,
}
