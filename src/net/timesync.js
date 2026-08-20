import { CONFIG } from '../config.js'

// ---- 純関数（ユニットテスト対象） ----

// ping 往復1回分から RTT とクロックオフセットを求める。
//   t0: host の送信時刻 / t1: player の応答時刻（player ローカル） / t2: host の受信時刻
// offset は「playerクロック − hostクロック」。応答が往復のちょうど中間
// （t0 + rtt/2）で行われたと仮定して推定する。
export function computeOffsetSample(t0, t1, t2) {
  const rtt = t2 - t0
  return { rtt, offset: t1 - (t0 + rtt / 2) }
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// 複数サンプルからオフセット推定値を得る。
// RTT が小さいサンプルほど往復の非対称誤差が小さいため、
// RTT 下位半分に絞ってから外れ値に頑健な中央値を取る（min-RTTフィルタ）
export function estimateOffset(samples) {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a.rtt - b.rtt)
  const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)))
  return median(best.map((s) => s.offset))
}

// ---- host が player ごとに保持する同期状態 ----
export class PeerSync {
  constructor(windowSize = CONFIG.sync.windowSize) {
    this.windowSize = windowSize
    this.samples = [] // { rtt, offset } のスライディングウィンドウ
    this.pending = new Map() // seq → t0。送信時刻は host 内部にのみ保持し player にエコーさせない
    this.nextSeq = 0
  }

  // ping 送信時に呼ぶ。払い出した seq をメッセージに載せる
  beginPing(now) {
    const seq = this.nextSeq
    this.nextSeq += 1
    this.pending.set(seq, now)
    return seq
  }

  // pong 受信時に呼ぶ。未知の seq は無視して false を返す
  handlePong(seq, t1, t2) {
    const t0 = this.pending.get(seq)
    if (t0 === undefined) return false
    this.pending.delete(seq)
    this.samples.push(computeOffsetSample(t0, t1, t2))
    if (this.samples.length > this.windowSize) this.samples.shift()
    return true
  }

  get offset() {
    return estimateOffset(this.samples)
  }

  get rtt() {
    if (this.samples.length === 0) return null
    return median(this.samples.map((s) => s.rtt))
  }
}
