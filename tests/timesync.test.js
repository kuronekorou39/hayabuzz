import { describe, expect, it } from 'vitest'
import { PeerSync, computeOffsetSample, estimateOffset, median } from '../src/net/timesync.js'

describe('computeOffsetSample', () => {
  it('往復時刻から RTT とオフセットを求める', () => {
    // host t0=100 で送信、player はローカル時刻 1060 で応答、host t2=120 で受信
    const { rtt, offset } = computeOffsetSample(100, 1060, 120)
    expect(rtt).toBe(20)
    // 応答は host 時計で 110（往復の中間）と推定 → playerクロックは 950ms 進んでいる
    expect(offset).toBe(950)
  })

  it('時計が一致していればオフセット 0', () => {
    const { offset } = computeOffsetSample(100, 110, 120)
    expect(offset).toBe(0)
  })

  it('player の時計が遅れていれば負のオフセット', () => {
    const { offset } = computeOffsetSample(1000, 510, 1020)
    expect(offset).toBe(-500)
  })
})

describe('median', () => {
  it('奇数個は中央の値', () => {
    expect(median([5, 1, 3])).toBe(3)
  })

  it('偶数個は中央2つの平均', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('1個ならその値', () => {
    expect(median([7])).toBe(7)
  })
})

describe('estimateOffset', () => {
  it('複数サンプルの中央値を採用し、外れ値に引きずられない', () => {
    const samples = [950, 949, 951, 1400, 950].map((offset) => ({ rtt: 20, offset }))
    expect(estimateOffset(samples)).toBe(950)
  })

  it('サンプルなしは null', () => {
    expect(estimateOffset([])).toBeNull()
  })

  it('RTTが大きい（誤差の乗りやすい）サンプルを除外して推定する', () => {
    const samples = [
      { rtt: 10, offset: 100 },
      { rtt: 12, offset: 101 },
      { rtt: 11, offset: 99 },
      { rtt: 200, offset: 250 }, // 混雑時の非対称なサンプル
      { rtt: 180, offset: 240 },
    ]
    expect(estimateOffset(samples)).toBe(100)
  })
})

describe('PeerSync', () => {
  it('ping/pong の往復でサンプルが貯まりオフセットを推定する', () => {
    const sync = new PeerSync()
    const seq = sync.beginPing(1000) // t0
    expect(sync.handlePong(seq, 5010, 1020)).toBe(true) // t1=5010, t2=1020
    expect(sync.offset).toBe(4000)
    expect(sync.rtt).toBe(20)
  })

  it('未知の seq の pong は無視する（t0 は host 内部にのみ保持）', () => {
    const sync = new PeerSync()
    expect(sync.handlePong(999, 0, 0)).toBe(false)
    expect(sync.offset).toBeNull()
  })

  it('同じ seq の pong は一度しか受け付けない', () => {
    const sync = new PeerSync()
    const seq = sync.beginPing(0)
    expect(sync.handlePong(seq, 10, 20)).toBe(true)
    expect(sync.handlePong(seq, 10, 20)).toBe(false)
    expect(sync.samples.length).toBe(1)
  })

  it('ウィンドウ長を超えた古いサンプルは捨てる', () => {
    const sync = new PeerSync(3)
    for (let i = 0; i < 5; i++) {
      const seq = sync.beginPing(i * 100)
      sync.handlePong(seq, i * 100 + 60, i * 100 + 20)
    }
    expect(sync.samples.length).toBe(3)
  })
})
