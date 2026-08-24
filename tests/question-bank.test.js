import { beforeEach, describe, expect, test } from 'vitest'
import {
  addQuestion,
  applyImport,
  exportPayload,
  importTsv,
  parseImport,
} from '../src/game/question-bank.js'

// localStorage を触る関数は使わないが、モジュール読み込み時に参照されても落ちないようにしておく
beforeEach(() => {
  globalThis.localStorage ??= {
    getItem: () => null,
    setItem: () => {},
  }
})

describe('問題の追加と重複', () => {
  test('同じ形式・同じ問題文は追加されない（前後の空白は無視）', () => {
    const items = []
    expect(addQuestion(items, { q: '日本の首都は？', a: '東京' })).not.toBeNull()
    expect(addQuestion(items, { q: '  日本の首都は？  ', a: '東京都' })).toBeNull()
    expect(items).toHaveLength(1)
  })

  test('形式が違えば同じ問題文でも別の問題として追加できる', () => {
    const items = []
    addQuestion(items, { type: 'buzzer', q: '同じ問題文' })
    expect(addQuestion(items, { type: 'ox', q: '同じ問題文', a: 'o' })).not.toBeNull()
    expect(items).toHaveLength(2)
  })
})

describe('貼り付け取り込み（TSV）', () => {
  test('列の並びで早押し・○×・4択を判別する', () => {
    const items = []
    const result = importTsv(
      items,
      [
        '富士山の標高は？\t3776m\tメートル単位で',
        'トマトは果物である\t○',
        '日本の都道府県はいくつ？\t43\t45\t47\t49\t3\t四択メモ',
      ].join('\n'),
    )
    expect(result).toEqual({ added: 3, skipped: 0 })
    expect(items[0]).toMatchObject({ type: 'buzzer', a: '3776m', memo: 'メートル単位で' })
    expect(items[1]).toMatchObject({ type: 'ox', a: 'o' })
    expect(items[2]).toMatchObject({ type: 'choice4', a: '3', choices: ['43', '45', '47', '49'], memo: '四択メモ' })
  })

  test('同じ内容を2度取り込んでも増えない', () => {
    const items = []
    const text = '問題A\t答えA\n問題B\t答えB'
    expect(importTsv(items, text)).toEqual({ added: 2, skipped: 0 })
    expect(importTsv(items, text)).toEqual({ added: 0, skipped: 2 })
    expect(items).toHaveLength(2)
  })
})

describe('ファイルへの書き出しと復元', () => {
  test('書き出した内容を読み戻すと、形式・選択肢・履歴が保たれる', () => {
    const items = []
    addQuestion(items, { type: 'choice4', q: '4択の問題', a: '2', choices: ['あ', 'い', 'う', 'え'] })
    items[0].history.push({ at: 1_700_000_000_000, winner: 'たろう', wrongs: ['はなこ'] })

    const restored = parseImport(exportPayload(items))
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      type: 'choice4',
      q: '4択の問題',
      a: '2',
      choices: ['あ', 'い', 'う', 'え'],
    })
    expect(restored[0].history[0]).toEqual({ at: 1_700_000_000_000, winner: 'たろう', wrongs: ['はなこ'] })
  })

  test('形式のない古いファイルは早押しとして復元される', () => {
    const payload = JSON.stringify({
      app: 'hayabuzz',
      version: 1,
      questions: [{ id: 'old12345', q: '昔の問題', a: '昔の答え', memo: '', history: [] }],
    })
    const restored = parseImport(payload)
    expect(restored[0]).toMatchObject({ type: 'buzzer', q: '昔の問題', choices: [] })
  })

  test('壊れたファイルや別アプリのファイルは null になる', () => {
    expect(parseImport('これはJSONではない')).toBeNull()
    expect(parseImport(JSON.stringify({ app: 'other', questions: [] }))).toBeNull()
  })

  test('復元は既定で追加（重複は取り込まない）', () => {
    const items = []
    addQuestion(items, { q: '既存の問題', a: '答え' })
    const incoming = parseImport(
      exportPayload([
        { id: 'aaaa1111', type: 'buzzer', q: '既存の問題', a: '答え', choices: [], memo: '', history: [] },
        { id: 'bbbb2222', type: 'buzzer', q: '新しい問題', a: '答え2', choices: [], memo: '', history: [] },
      ]),
    )
    expect(applyImport(items, incoming)).toEqual({ added: 1, skipped: 1 })
    expect(items.map((i) => i.q)).toEqual(['既存の問題', '新しい問題'])
  })

  test('replace 指定なら今の問題集を空にしてから入れ替える', () => {
    const items = []
    addQuestion(items, { q: '消える問題', a: '答え' })
    const incoming = parseImport(
      exportPayload([{ id: 'cccc3333', type: 'buzzer', q: '入れ替え後の問題', a: '答え', choices: [], memo: '', history: [] }]),
    )
    expect(applyImport(items, incoming, { replace: true })).toEqual({ added: 1, skipped: 0 })
    expect(items.map((i) => i.q)).toEqual(['入れ替え後の問題'])
  })
})
