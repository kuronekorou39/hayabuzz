// ゲームフェーズ（遷移は host のみが行う）
export const PHASE = {
  WAITING: 'waiting', // 待機（問題なし）
  QUESTION: 'question', // 問題表示中
  ARMED: 'armed', // 早押し受付中
  LOCKED: 'locked', // 誰かが押した（判定待ち）/ 一斉回答の締め切り後
  RESULT: 'result', // 判定結果表示（次の問題待ち）
  FINAL: 'final', // ゲーム終了（最終ランキング表示）
}

export const PHASE_LABEL = {
  [PHASE.WAITING]: '出題待ち',
  [PHASE.QUESTION]: '問題表示中',
  [PHASE.ARMED]: '早押し受付中！',
  [PHASE.LOCKED]: '回答中…',
  [PHASE.RESULT]: '判定結果',
  [PHASE.FINAL]: '結果発表',
}

// 一斉回答モード（○×・4択）ではフェーズの意味が変わる
export const MASS_PHASE_LABEL = {
  [PHASE.ARMED]: '回答受付中！',
  [PHASE.LOCKED]: '締め切り・判定待ち',
}
