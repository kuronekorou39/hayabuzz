import { describe, expect, it } from 'vitest'
import { judgeBuzzes, pickActive, toHostTime } from '../src/game/buzz.js'

describe('toHostTime', () => {
  it('オフセット（playerClock − hostClock）を引いて host 時計に換算する', () => {
    expect(toHostTime(5000, 4000)).toBe(1000)
    expect(toHostTime(500, -500)).toBe(1000)
  })
})

describe('judgeBuzzes', () => {
  it('到着順ではなく換算時刻の昇順で順位を決める', () => {
    // 到着順は A → B だが、換算時刻は B のほうが早い
    const presses = [
      { playerId: 'A', hostT: 1100 },
      { playerId: 'B', hostT: 1050 },
    ]
    const { order, invalid } = judgeBuzzes({ armedAt: 1000, presses })
    expect(order.map((o) => o.playerId)).toEqual(['B', 'A'])
    expect(order[0].deltaMs).toBe(0)
    expect(order[1].deltaMs).toBe(50)
    expect(invalid).toEqual([])
  })

  it('オフセットの異なる player の押下を換算した上で比較できる', () => {
    // A: ローカル 5100・オフセット +4000 → host 1100
    // B: ローカル  980・オフセット  −70 → host 1050
    const presses = [
      { playerId: 'A', hostT: toHostTime(5100, 4000) },
      { playerId: 'B', hostT: toHostTime(980, -70) },
    ]
    const { order } = judgeBuzzes({ armedAt: 1000, presses })
    expect(order.map((o) => o.playerId)).toEqual(['B', 'A'])
    expect(order[1].deltaMs).toBe(50)
  })

  it('受付開始（armedAt）より前の押下はフライングとして無効', () => {
    const presses = [
      { playerId: 'A', hostT: 990 },
      { playerId: 'B', hostT: 1010 },
    ]
    const { order, invalid } = judgeBuzzes({ armedAt: 1000, presses })
    expect(invalid).toEqual(['A'])
    expect(order.map((o) => o.playerId)).toEqual(['B'])
    expect(order[0].deltaMs).toBe(0)
  })

  it('全員フライングなら順位は空', () => {
    const presses = [{ playerId: 'A', hostT: 900 }]
    const { order, invalid } = judgeBuzzes({ armedAt: 1000, presses })
    expect(order).toEqual([])
    expect(invalid).toEqual(['A'])
  })

  it('押下なしでも壊れない', () => {
    const { order, invalid } = judgeBuzzes({ armedAt: 1000, presses: [] })
    expect(order).toEqual([])
    expect(invalid).toEqual([])
  })
})

describe('pickActive', () => {
  const order = [
    { playerId: 'A', hostT: 1010, deltaMs: 0 },
    { playerId: 'B', hostT: 1020, deltaMs: 10 },
    { playerId: 'C', hostT: 1030, deltaMs: 20 },
  ]

  it('先頭の player に回答権を与える', () => {
    expect(pickActive(order, new Set())).toBe('A')
  })

  it('除外済み（誤答者）を飛ばして次点に権利を回す', () => {
    expect(pickActive(order, new Set(['A']))).toBe('B')
    expect(pickActive(order, new Set(['A', 'B']))).toBe('C')
  })

  it('全員除外なら null', () => {
    expect(pickActive(order, new Set(['A', 'B', 'C']))).toBeNull()
  })
})
