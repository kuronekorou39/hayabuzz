// 押下順判定の純関数群。到着順ではなく host 時計に換算した押下時刻で順位を決める。

// player ローカル時刻を host 時計に換算する（offset = playerClock − hostClock）
export function toHostTime(localT, offset) {
  return localT - offset
}

// presses: [{ playerId, hostT }]（host 時計に換算済みの押下時刻）
// 返り値の order は hostT 昇順。deltaMs は1位との差（1位は 0）。
// armedAt（受付開始の host 時刻）より前の押下はフライングとして invalid に分類する。
export function judgeBuzzes({ armedAt, presses }) {
  const valid = []
  const invalid = []
  for (const press of presses) {
    if (press.hostT < armedAt) invalid.push(press.playerId)
    else valid.push(press)
  }
  valid.sort((a, b) => a.hostT - b.hostT)
  const top = valid.length > 0 ? valid[0].hostT : 0
  return {
    order: valid.map((p) => ({
      playerId: p.playerId,
      hostT: p.hostT,
      deltaMs: p.hostT - top,
    })),
    invalid,
  }
}

// 回答権を持つ player を順位から選ぶ（誤答などで除外された player はスキップ）
export function pickActive(order, excluded) {
  const entry = order.find((o) => !excluded.has(o.playerId))
  return entry ? entry.playerId : null
}
