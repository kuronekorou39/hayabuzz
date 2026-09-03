// 運用で調整しうる値をここに集約する
export const CONFIG = {
  // 通信
  appId: 'hayabuzz-v1', // 部屋トピックの名前空間（info_hash の材料）
  joinTimeoutMs: 15000, // 参加確立（welcome受信）までの待ち時間
  // host からの応答（定期同期は10秒ごと）が途絶えたと判断するまでの時間。
  // DataChannel は信頼配送なので、1周期 + 余裕を超えた無音は回線断とみなせる
  hostSilenceTimeoutMs: 15000,
  maxPlayers: 24,
  // 出題者が部屋を離れて（リロード・タブを閉じる等）から、同じ部屋に復帰できる時間。
  // これを過ぎた保存は「前の部屋」として扱わない（古い部屋に戻ってしまわないように）
  hostRoomTtlMs: 6 * 60 * 60 * 1000,

  // シグナリング（WebTorrent トラッカーの WebSocket プロトコルを自前実装で使用）
  signaling: {
    trackerUrls: [
      'wss://tracker.webtorrent.dev',
      'wss://tracker.openwebtorrent.com',
      'wss://open.ftorrent.com',
    ],
    announceIntervalMs: 10000, // 定期 announce（新規参加者が offer を受け取れる周期）
    reconnectBaseMs: 2000, // トラッカー切断時の再接続（指数バックオフの初期値）
    reconnectMaxMs: 30000,
    numwant: 8, // トラッカーに希望する offer 配布先ピア数
    offerPool: 3, // 待ち受け offer の常備数
    offerTtlMs: 120000, // 古い offer を作り直すまでの時間（ICE 候補の失効対策）
    iceGatherTimeoutMs: 1600, // ICE 候補収集の打ち切り時間
    dedupeWindowMs: 4000, // 複数トラッカー経由の重複シグナル排除窓
  },

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
  roomCodeLen: 4, // 招待した仲間内で使う前提なので、手入力しやすい短さを優先
  sessionIdLen: 16,
}
