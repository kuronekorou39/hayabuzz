import { beforeEach, describe, expect, test } from 'vitest'
import {
  addQuestion,
  applyImport,
  exportPayload,
  filterQuestions,
  importTsv,
  parseImport,
  pickRandomQuestion,
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
  test('指定した形式の列の並びで取り込む', () => {
    const buzzer = []
    expect(importTsv(buzzer, '富士山の標高は？\t3776m\tメートル単位で', 'buzzer')).toEqual({ added: 1, skipped: 0 })
    expect(buzzer[0]).toMatchObject({ type: 'buzzer', a: '3776m', memo: 'メートル単位で' })

    const ox = []
    importTsv(ox, 'トマトは果物である\t○\t植物学上は', 'ox')
    expect(ox[0]).toMatchObject({ type: 'ox', a: 'o', memo: '植物学上は' })

    const choice4 = []
    importTsv(choice4, '日本の都道府県はいくつ？\t43\t45\t47\t49\t3\t四択メモ', 'choice4')
    expect(choice4[0]).toMatchObject({ type: 'choice4', a: '3', choices: ['43', '45', '47', '49'], memo: '四択メモ' })
  })

  test('答えが「○」の早押し問題を、○×として取り込まない', () => {
    const items = []
    importTsv(items, 'この記号はどっち？\t○\t早押しのつもり', 'buzzer')
    expect(items[0]).toMatchObject({ type: 'buzzer', a: '○' })
  })

  test('正解が読み取れない行は「正解は未定」として取り込む', () => {
    const items = []
    importTsv(items, '正解が空の○×問題\t\tメモ', 'ox')
    importTsv(items, '番号のない4択\tあ\tい\tう\tえ', 'choice4')
    expect(items[0]).toMatchObject({ type: 'ox', a: '' })
    expect(items[1]).toMatchObject({ type: 'choice4', a: '', choices: ['あ', 'い', 'う', 'え'] })
  })

  test('同じ内容を2度取り込んでも増えない', () => {
    const items = []
    const text = '問題A\t答えA\n問題B\t答えB'
    expect(importTsv(items, text, 'buzzer')).toEqual({ added: 2, skipped: 0 })
    expect(importTsv(items, text, 'buzzer')).toEqual({ added: 0, skipped: 2 })
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

describe('一覧の絞り込み', () => {
  const build = () => {
    const items = []
    addQuestion(items, { type: 'buzzer', q: '日本の首都は？', a: '東京', memo: '都道府県の話' })
    addQuestion(items, { type: 'ox', q: 'カンガルーは後ろ向きに歩けない', a: 'o' })
    addQuestion(items, { type: 'choice4', q: '五大陸で最大は？', choices: ['アフリカ', 'ユーラシア', '北米', '南米'], a: '2' })
    return items
  }

  test('条件がなければ全件返す', () => {
    const items = build()
    expect(filterQuestions(items, {})).toHaveLength(3)
    expect(filterQuestions(items, { type: '', text: '   ' })).toHaveLength(3)
  })

  test('形式で絞り込める', () => {
    expect(filterQuestions(build(), { type: 'ox' }).map((i) => i.type)).toEqual(['ox'])
  })

  test('問題文・メモ・選択肢のどれに含まれていても見つかる', () => {
    const items = build()
    expect(filterQuestions(items, { text: '首都' }).map((i) => i.q)).toEqual(['日本の首都は？'])
    expect(filterQuestions(items, { text: '都道府県' }).map((i) => i.q)).toEqual(['日本の首都は？'])
    expect(filterQuestions(items, { text: 'ユーラシア' }).map((i) => i.q)).toEqual(['五大陸で最大は？'])
  })

  test('○× の答えは画面と同じ記号で探せる', () => {
    expect(filterQuestions(build(), { text: '○' })).toHaveLength(1)
    expect(filterQuestions(build(), { text: '×' })).toHaveLength(0)
  })

  test('英字の大文字小文字は区別しない', () => {
    const items = []
    addQuestion(items, { q: 'HTML の略は？', a: 'HyperText Markup Language' })
    expect(filterQuestions(items, { text: 'html' })).toHaveLength(1)
    expect(filterQuestions(items, { text: 'HYPERTEXT' })).toHaveLength(1)
  })

  test('形式と文字列は同時に効く', () => {
    const items = build()
    expect(filterQuestions(items, { type: 'buzzer', text: '首都' })).toHaveLength(1)
    expect(filterQuestions(items, { type: 'ox', text: '首都' })).toHaveLength(0)
  })
})

describe('ランダムに選ぶ', () => {
  test('形式で絞り、出題済みを除いた中から選ぶ', () => {
    const items = []
    addQuestion(items, { type: 'buzzer', q: 'B1' })
    addQuestion(items, { type: 'buzzer', q: 'B2' })
    addQuestion(items, { type: 'ox', q: 'O1', a: 'o' })
    const [b1, b2] = items
    expect(pickRandomQuestion(items, { type: 'buzzer', exclude: new Set([b1.id]) })).toBe(b2)
    // 乱数源を差し替えると先頭・末尾を決め打ちで選べる（○×は候補に入らない）
    expect(pickRandomQuestion(items, { type: 'buzzer', rand: () => 0 })).toBe(b1)
    expect(pickRandomQuestion(items, { type: 'buzzer', rand: () => 0.999 })).toBe(b2)
  })

  test('候補がなければ null', () => {
    const items = []
    addQuestion(items, { type: 'buzzer', q: 'B1' })
    expect(pickRandomQuestion(items, { type: 'ox' })).toBeNull()
    expect(pickRandomQuestion(items, { type: 'buzzer', exclude: new Set([items[0].id]) })).toBeNull()
    expect(pickRandomQuestion([], {})).toBeNull()
  })
})
