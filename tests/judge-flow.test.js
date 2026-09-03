import { describe, expect, test } from 'vitest'
import { HostGame } from '../src/game/host-game.js'
import { PHASE } from '../src/game/phases.js'
import { MSG, PROTO_VERSION } from '../src/net/protocol.js'

const S1 = 'S1aaaaaaaaaaaaaa'
const S2 = 'S2aaaaaaaaaaaaaa'
const S3 = 'S3aaaaaaaaaaaaaa'

function join(game, sessionId, nick, peerId) {
  game.handleMessage({ type: MSG.HELLO, proto: PROTO_VERSION, sessionId, nick }, peerId)
}

// 2人が押して S1 に回答権がある判定待ちを作る（押下は時刻同期を介するので直接組み立てる）
function lockedWithTwo(overrides = {}) {
  const game = new HostGame({ send: () => {}, now: () => 0, ...overrides })
  join(game, S1, 'たろう', 'p1')
  join(game, S2, 'はなこ', 'p2')
  game.startQuestion({ text: '問題', answer: '答え' })
  game.phase = PHASE.LOCKED
  game.order = [{ playerId: S1, deltaMs: 0 }, { playerId: S2, deltaMs: 5 }]
  game.activePlayerId = S1
  return game
}

describe('誤答のあとの進め方', () => {
  test('「誤答」はペナルティと回答権の取り上げだけで、進め方は別に選ぶ', () => {
    const game = lockedWithTwo()
    game.setWrongPoints(-1)
    game.judgeWrong()
    expect(game.phase).toBe(PHASE.LOCKED)
    expect(game.activePlayerId).toBeNull()
    expect(game.isChoosingAfterWrong).toBe(true)
    expect(game.players.get(S1).score).toBe(-1)
    expect([...game.excluded]).toEqual([S1])
    expect(game.nextCandidateId).toBe(S2)
    game.destroy()
  })

  test('次点へ: 次に押していた人に回答権が移る', () => {
    const game = lockedWithTwo()
    game.judgeWrong()
    game.passToNext()
    expect(game.phase).toBe(PHASE.LOCKED)
    expect(game.activePlayerId).toBe(S2)
    expect(game.isChoosingAfterWrong).toBe(false)
    game.destroy()
  })

  test('次点がいなければ「次点へ」は何もしない', () => {
    const game = lockedWithTwo()
    game.order = [{ playerId: S1, deltaMs: 0 }]
    game.judgeWrong()
    expect(game.nextCandidateId).toBeNull()
    game.passToNext()
    expect(game.activePlayerId).toBeNull()
    expect(game.phase).toBe(PHASE.LOCKED)
    game.destroy()
  })

  test('正解者なしで終了: 次点がいても打ち切れる', () => {
    const game = lockedWithTwo()
    game.judgeWrong()
    game.endNoWinner()
    expect(game.phase).toBe(PHASE.RESULT)
    expect(game.result).toEqual({ playerId: null, correct: false })
    expect(game.askedLog[0].decided).toBe(true)
    game.destroy()
  })

  test('全員に再開放: 誤答者を除いて受付が再開し、読み上げは続きから', () => {
    let now = 0
    const game = lockedWithTwo({ now: () => now })
    game.setReveal('serial')
    game.revealBase = 6
    game.judgeWrong()
    now = 500
    game.reopenAll()
    expect(game.phase).toBe(PHASE.ARMED)
    expect(game.armedAt).toBe(500)
    expect(game.revealBase).toBe(6)
    expect([...game.excluded]).toEqual([S1])
    expect(game.order).toEqual([])
    game.destroy()
  })

  test('最初から読み直し: 読み上げ位置が先頭に戻る', () => {
    const game = lockedWithTwo()
    game.setReveal('serial')
    game.revealBase = 6
    game.judgeWrong()
    game.reopenAll({ fromStart: true })
    expect(game.phase).toBe(PHASE.ARMED)
    expect(game.revealBase).toBe(0)
    game.destroy()
  })

  test('他チームに開放: 誤答者のチーム全員が除外される', () => {
    const game = lockedWithTwo()
    join(game, S3, 'じろう', 'p3')
    game.setTeams(2) // 参加順で たろう=1, はなこ=2, じろう=1
    game.judgeWrong()
    game.openOtherTeams()
    expect(game.phase).toBe(PHASE.ARMED)
    expect([...game.excluded].sort()).toEqual([S1, S3].sort())
    game.destroy()
  })

  test('回答権を持つ人がいる間は進め方の操作を受け付けない', () => {
    const game = lockedWithTwo()
    game.passToNext()
    game.endNoWinner()
    game.reopenAll()
    expect(game.phase).toBe(PHASE.LOCKED)
    expect(game.activePlayerId).toBe(S1)
    game.destroy()
  })
})

describe('判定結果から次の問題へ', () => {
  test('判定後は結果を残したまま止まり、「次の問題へ」で出題前に戻る', () => {
    const game = lockedWithTwo()
    game.judgeCorrect()
    expect(game.phase).toBe(PHASE.RESULT)
    expect(game.questionText).toBe('問題')
    expect(game.order).toHaveLength(2)
    game.nextQuestion()
    expect(game.phase).toBe(PHASE.WAITING)
    expect(game.questionText).toBe('')
    expect(game.answerText).toBe('')
    expect(game.order).toEqual([])
    expect(game.result).toBeNull()
    expect(game.excluded.size).toBe(0)
    expect(game.qid).toBe(1) // 番号と履歴は残る（次は Q2）
    expect(game.askedLog).toHaveLength(1)
    game.destroy()
  })

  test('「次の問題へ」は判定結果のときだけ効く', () => {
    const game = lockedWithTwo()
    game.nextQuestion()
    expect(game.phase).toBe(PHASE.LOCKED)
    game.destroy()
  })

  test('結果発表から戻ると、途中だった問題は引っ込む', () => {
    const game = lockedWithTwo()
    game.finishGame()
    game.resumeGame()
    expect(game.phase).toBe(PHASE.WAITING)
    expect(game.questionText).toBe('')
    expect(game.activePlayerId).toBeNull()
    game.destroy()
  })
})
