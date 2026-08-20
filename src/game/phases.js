// ゲームフェーズ（遷移は host のみが行う）
export const PHASE = {
  WAITING: 'waiting', // 待機（問題なし）
  QUESTION: 'question', // 問題表示中
  ARMED: 'armed', // 早押し受付中
  LOCKED: 'locked', // 誰かが押した（判定待ち）
  RESULT: 'result', // 判定結果表示（次の問題待ち）
}

export const PHASE_LABEL = {
  [PHASE.WAITING]: '出題待ち',
  [PHASE.QUESTION]: '問題表示中',
  [PHASE.ARMED]: '早押し受付中！',
  [PHASE.LOCKED]: '回答中…',
  [PHASE.RESULT]: '判定結果',
}
