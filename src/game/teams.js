// チームの表示定義（index 1〜4。0 は未所属/個人戦）
export const TEAM_META = [
  null,
  { label: '赤', cls: 't1' },
  { label: '青', cls: 't2' },
  { label: '黄', cls: 't3' },
  { label: '緑', cls: 't4' },
]

export function teamMeta(team) {
  return TEAM_META[team] ?? null
}

// players: [{ team, score }] からチームごとの合計得点を出す
export function teamTotals(players, teamCount) {
  const totals = []
  for (let team = 1; team <= teamCount; team++) {
    totals.push({
      team,
      score: players.filter((p) => p.team === team).reduce((sum, p) => sum + p.score, 0),
    })
  }
  return totals
}
