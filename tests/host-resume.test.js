import { describe, expect, test } from 'vitest'
import { HostGame } from '../src/game/host-game.js'
import { PHASE } from '../src/game/phases.js'
import { MSG, PROTO_VERSION } from '../src/net/protocol.js'

const S1 = 'S1aaaaaaaaaaaaaa'
const S2 = 'S2aaaaaaaaaaaaaa'

function makeGame(overrides = {}) {
  return new HostGame({ send: () => {}, now: () => 0, ...overrides })
}

function join(game, sessionId, nick, peerId) {
  game.handleMessage({ type: MSG.HELLO, proto: PROTO_VERSION, sessionId, nick }, peerId)
}

// 保存→復元。実際の保存と同じく JSON を経由し、保存形式に乗らない値が混ざっていないことも確かめる
function roundTrip(game) {
  const restored = makeGame()
  restored.restore(JSON.parse(JSON.stringify(game.serialize())))
  return restored
}

describe('出題者の復帰（serialize / restore）', () => {
  test('参加者の得点・ルール・履歴・判定結果を引き継ぎ、参加者は切断中として戻る', () => {
    const game = makeGame()
    join(game, S1, 'たろう', 'p1')
    join(game, S2, 'はなこ', 'p2')
    game.setCorrectPoints(3)
    game.setTeams(2)
    game.showQuestion({ text: '1問目', answer: '答え' })
    game.phase = PHASE.LOCKED
    game.order = [{ playerId: S1, deltaMs: 0 }]
    game.activePlayerId = S1
    game.judgeCorrect()

    const restored = roundTrip(game)
    expect(restored.phase).toBe(PHASE.RESULT)
    expect(restored.qid).toBe(1)
    expect(restored.rules.correctPoints).toBe(3)
    expect(restored.rules.teams).toBe(2)
    expect(restored.askedLog).toEqual(game.askedLog)
    expect(restored.result).toEqual({ playerId: S1, correct: true })
    expect(restored.order).toEqual([{ playerId: S1, deltaMs: 0 }])
    const players = [...restored.players.values()]
    expect(players.map((p) => [p.nick, p.score, p.team, p.connected])).toEqual([
      ['たろう', 3, 1, false],
      ['はなこ', 0, 2, false],
    ])
    game.destroy()
  })

  test('復元後に同じセッションIDで参加し直すと、得点ごと復帰（resumed）になる', () => {
    const game = makeGame()
    join(game, S1, 'たろう', 'p1')
    game.adjustScore(S1, 5)

    const sent = []
    const restored = makeGame({ send: (msg) => sent.push(msg) })
    restored.restore(game.serialize())
    join(restored, S1, 'たろう', 'p9')
    const welcome = sent.find((m) => m.type === MSG.WELCOME)
    expect(welcome.resumed).toBe(true)
    expect(restored.players.get(S1).score).toBe(5)
    expect(restored.players.get(S1).connected).toBe(true)
    game.destroy()
    restored.destroy()
  })

  test('早押しの判定待ちは受付停止の状態に戻る（誤答者の除外は残す）', () => {
    const game = makeGame()
    join(game, S1, 'たろう', 'p1')
    join(game, S2, 'はなこ', 'p2')
    game.showQuestion({ text: '問題' })
    game.arm()
    game.phase = PHASE.LOCKED
    game.order = [{ playerId: S1, deltaMs: 0 }, { playerId: S2, deltaMs: 5 }]
    game.activePlayerId = S1
    game.judgeWrongNext() // たろう誤答 → はなこに回答権（判定待ちのまま）

    const restored = roundTrip(game)
    expect(restored.phase).toBe(PHASE.QUESTION)
    expect(restored.questionText).toBe('問題')
    expect(restored.armedAt).toBeNull()
    expect(restored.order).toEqual([])
    expect(restored.activePlayerId).toBeNull()
    expect([...restored.excluded]).toEqual([S1])
    game.destroy()
  })

  test('一斉回答: 受付中は回答を捨てて受付停止の状態に戻り、締め切り後は回答を保ったまま発表できる', () => {
    const game = makeGame()
    join(game, S1, 'たろう', 'p1')
    game.setAnswerMode('ox')
    game.showQuestion({ text: '○×問題' })
    game.arm()
    game.handleMessage({ type: MSG.ANSWER, qid: 1, value: 'o' }, 'p1')

    const armed = roundTrip(game)
    expect(armed.phase).toBe(PHASE.QUESTION)
    expect(armed.answers.size).toBe(0)

    game.closeAnswers()
    const locked = roundTrip(game)
    expect(locked.phase).toBe(PHASE.LOCKED)
    expect([...locked.answers.entries()]).toEqual([[S1, 'o']])
    locked.declareCorrect('o')
    expect(locked.phase).toBe(PHASE.RESULT)
    expect(locked.players.get(S1).score).toBe(1)
    game.destroy()
  })

  test('読み上げ（順次表示）の受付中に保存すると、そこまで進んだ位置から再開できる', () => {
    let now = 0
    const game = makeGame({ now: () => now })
    game.setReveal('serial')
    game.setRevealCps(4)
    game.showQuestion({ text: '十二文字の問題文です。' })
    game.arm()
    now = 2000 // 2秒 × 4文字/秒 = 8文字
    const restored = roundTrip(game)
    expect(restored.revealBase).toBe(8)
    expect(restored.phase).toBe(PHASE.QUESTION)
    game.destroy()
  })

  test('欠けた項目があっても既定値で開ける（保存の一部が壊れていても部屋を開けなくならない）', () => {
    const restored = makeGame()
    restored.restore({ phase: 'nonsense', players: [{ sessionId: S1, nick: 'たろう', score: 2, handicapMs: 0, team: 0 }] })
    expect(restored.phase).toBe(PHASE.WAITING)
    expect(restored.qid).toBe(0)
    expect(restored.rules.answerMode).toBe('buzzer')
    expect(restored.players.get(S1).score).toBe(2)
  })
})

describe('読み上げ位置の凍結', () => {
  test('判定待ちからの受付停止で、押下で止めた位置を二重に進めない', () => {
    let now = 0
    const game = makeGame({ now: () => now })
    join(game, S1, 'たろう', 'p1')
    game.players.get(S1).sync.samples.push({ rtt: 0, offset: 0 }) // 時計は host と一致しているとみなす
    game.setReveal('serial')
    game.setRevealCps(4)
    game.showQuestion({ text: '十二文字の問題文です。' })
    game.arm()
    now = 1000
    game.handleMessage({ type: MSG.BUZZ, qid: 1, t: 1000 }, 'p1') // 押下で凍結（1秒 × 4文字/秒）
    expect(game.phase).toBe(PHASE.LOCKED)
    expect(game.revealBase).toBe(4)
    now = 3000
    game.stop()
    expect(game.phase).toBe(PHASE.QUESTION)
    expect(game.revealBase).toBe(4)
    game.destroy()
  })
})
