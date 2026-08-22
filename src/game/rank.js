// 得点順の順位とマーク（回答者の得点表・結果発表と、出題者の参加者一覧で共用）

// 同点は同順位
export function scoreRank(players, p) {
  return 1 + players.filter((other) => other.score > p.score).length
}

// 順位マーク（ルール rankBadges で切替）。最下位タイには付けない
// （開始直後の全員同点で全員に付いたり、少人数の最下位にメダルが付くのを防ぐ）
export function rankMark(players, p, mode) {
  if (mode === 'none') return ''
  if (!players.some((other) => other.score < p.score)) return ''
  const rank = scoreRank(players, p)
  if (mode === 'first') return rank === 1 ? '👑' : ''
  return rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : ''
}
