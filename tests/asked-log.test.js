import { describe, expect, test } from 'vitest'
import { HostGame } from '../src/game/host-game.js'
import { PHASE } from '../src/game/phases.js'
import { MSG, PROTO_VERSION } from '../src/net/protocol.js'

function makeGame() {
  return new HostGame({ send: () => {}, now: () => 0 })
}

function join(game, sessionId, nick, peerId) {
  game.handleMessage({ type: MSG.HELLO, proto: PROTO_VERSION, sessionId, nick }, peerId)
}

describe('出題履歴（askedLog）', () => {
  test('早押し: 誤答→次点の正解が記録される', () => {
    const game = makeGame()
    join(game, 'S1aaaaaaaaaaaaaa', 'たろう', 'p1')
    join(game, 'S2aaaaaaaaaaaaaa', 'はなこ', 'p2')
    const [id1, id2] = [...game.players.keys()]
    game.showQuestion('テスト問題', 'テスト答え')
    // 押下順が付いた状態を直接作る（時刻同期を介した実際の押下は e2e で検証している）
    game.phase = PHASE.LOCKED
    game.order = [{ playerId: id1, deltaMs: 0 }, { playerId: id2, deltaMs: 10 }]
    game.activePlayerId = id1
    game.judgeWrongNext() // たろう誤答 → はなこに回答権
    game.judgeCorrect() // はなこ正解

    const entry = game.askedLog[0]
    expect(entry.qid).toBe(1)
    expect(entry.answer).toBe('テスト答え')
    expect(entry.wrongs).toEqual(['たろう'])
    expect(entry.winners).toEqual(['はなこ'])
    expect(entry.decided).toBe(true)
    game.destroy()
  })

  test('次点がいない誤答は正解者なしとして確定する', () => {
    const game = makeGame()
    join(game, 'S1aaaaaaaaaaaaaa', 'たろう', 'p1')
    const [id1] = [...game.players.keys()]
    game.showQuestion('テスト問題')
    game.phase = PHASE.LOCKED
    game.order = [{ playerId: id1, deltaMs: 0 }]
    game.activePlayerId = id1
    game.judgeWrongNext()

    const entry = game.askedLog[0]
    expect(entry.winners).toEqual([])
    expect(entry.wrongs).toEqual(['たろう'])
    expect(entry.decided).toBe(true)
    game.destroy()
  })

  test('一斉回答（○×）: 正解者と誤答者が分かれて記録される', () => {
    const game = makeGame()
    join(game, 'S1aaaaaaaaaaaaaa', 'たろう', 'p1')
    join(game, 'S2aaaaaaaaaaaaaa', 'はなこ', 'p2')
    game.setAnswerMode('ox')
    game.showQuestion('○×問題')
    game.arm()
    game.handleMessage({ type: MSG.ANSWER, qid: game.qid, value: 'o' }, 'p1')
    game.handleMessage({ type: MSG.ANSWER, qid: game.qid, value: 'x' }, 'p2')
    game.closeAnswers()
    game.declareCorrect('o')

    const entry = game.askedLog[0]
    expect(entry.winners).toEqual(['たろう'])
    expect(entry.wrongs).toEqual(['はなこ'])
    expect(entry.decided).toBe(true)
    game.destroy()
  })
})
