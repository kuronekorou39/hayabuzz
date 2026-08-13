// 運用で調整しうる値をここに集約する
export const CONFIG = {
  // 通信
  appId: 'hayabuzz-v1', // Trystero のアプリ識別子（部屋名の名前空間）
  joinTimeoutMs: 15000, // 参加確立（welcome受信）までの待ち時間
  maxPlayers: 24,

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
