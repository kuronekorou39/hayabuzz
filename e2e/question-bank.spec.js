import { expect, test } from '@playwright/test'
import { SAMPLE_QUESTIONS } from '../src/game/sample-questions.js'
import { createRoom, joinPlayer, openScoreSheet, pressBuzzer } from './helpers.js'

test('問題集: 追加→出題→答えの手元表示→正解者名の記録→貼り付け取り込み', async ({ browser }) => {
  const host = await createRoom(browser)
  const p1 = await joinPlayer(browser, host.code, 'たろう')

  // 問題集に1問追加（追加フォームは折りたたみの中）
  await host.page.getByRole('button', { name: '問題集から選ぶ' }).click()
  await host.page.locator('.form-toggle').click()
  await host.page.locator('.bank-q-input').fill('富士山の標高は？')
  await host.page.locator('.bank-a-input').fill('3776m')
  await host.page.locator('.bank-memo-input').fill('メートル単位で回答')
  await host.page.getByRole('button', { name: '追加する' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(1)

  // 一覧から「選ぶ」= 出題欄に読み込むだけ。この時点ではまだ回答者には出ない
  await host.page.locator('.bank-row').getByRole('button', { name: '選ぶ' }).click()
  await expect(host.page.locator('.question-input')).toHaveValue('富士山の標高は？')
  await expect(host.page.locator('.ask-a-input')).toHaveValue('3776m') // 答えも入力欄に入る
  await expect(host.page.locator('.answer-note')).toContainText('メモ: メートル単位で回答')
  await expect(p1.page.locator('.q-badge')).toBeHidden() // まだ出題していない

  // 「問題を表示」で初めて配信される
  await host.page.getByRole('button', { name: '全員に出題' }).click()
  await expect(p1.page.locator('.question-text')).toContainText('富士山の標高は？')
  await expect(p1.page.locator('.q-badge')).toHaveText('Q1')
  // 出題中の問題文は入力欄に残る（編集はできない）
  await expect(host.page.locator('.question-input')).toBeDisabled()
  // player 側には答えは一切表示されない（DOM 全体に含まれない）
  await expect(p1.page.locator('body')).not.toContainText('3776m')

  // 出題中は問題集から選び直せない
  await host.page.getByRole('button', { name: '問題集から選ぶ' }).click()
  await expect(host.page.locator('.bank-row').getByRole('button', { name: '選ぶ' })).toBeDisabled()
  await host.page.locator('.bank-overlay').getByRole('button', { name: '閉じる' }).click()

  // 判定まで進めると出題履歴に正解者名が残る
  await host.page.waitForTimeout(2200)
  await host.page.getByRole('button', { name: '早押し開始' }).click()
  await expect(p1.page.locator('.buzzer')).toHaveClass(/\barmed\b/)
  await pressBuzzer(p1.page)
  await expect(p1.page.locator('.buzzer-label')).toHaveText('回答してください！')
  await host.page.getByRole('button', { name: '正解', exact: true }).click()
  // 判定結果になって初めて player 側に答えが表示される
  await expect(p1.page.locator('.phase-banner')).toContainText('答え：3776m')

  await host.page.getByRole('button', { name: '問題集から選ぶ' }).click()
  await expect(host.page.locator('.bank-row')).toContainText('たろう')
  await expect(host.page.locator('.bank-row')).toContainText('1回')
  await host.page.locator('.bank-overlay').getByRole('button', { name: '閉じる' }).click()

  // セッションの出題履歴に問題・答え・正解者が残る（履歴は参加者シートの中）
  await openScoreSheet(host.page)
  await host.page.getByRole('button', { name: '履歴', exact: true }).click()
  await expect(host.page.locator('.history-overlay')).toContainText('富士山の標高は？')
  await expect(host.page.locator('.history-overlay')).toContainText('答え: 3776m')
  await expect(host.page.locator('.history-overlay')).toContainText('正解: たろう')
  await host.page.locator('.history-overlay').getByRole('button', { name: '閉じる' }).click()
  await host.page.getByRole('button', { name: '問題集から選ぶ' }).click()

  // スプレッドシート形式（タブ区切り）の貼り付け取り込み（折りたたみの中）
  await host.page.getByRole('button', { name: 'まとめて入れる・持ち出す' }).click()
  await host.page.locator('.bank-paste').fill('Q2\tA2\nQ3\tA3\tメモ3')
  await host.page.getByRole('button', { name: '貼り付けから追加' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(3)

  // サンプルの取り込み（既存3問 + サンプル。再度押しても重複しない）
  const withSamples = 3 + SAMPLE_QUESTIONS.length
  await host.page.getByRole('button', { name: /お試し用の問題/ }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(withSamples)
  await host.page.getByRole('button', { name: /お試し用の問題/ }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(withSamples)

  await p1.context.close()
  await host.context.close()
})

test('問題の編集: 一覧の「編集」でフォームに値が入り、保存すると一覧に反映される', async ({ browser }) => {
  const host = await createRoom(browser)

  // ○×の問題を1問追加
  await host.page.getByRole('button', { name: '問題集から選ぶ' }).click()
  await host.page.locator('.form-toggle').click()
  await host.page.locator('.bank-type-select').selectOption('ox')
  await host.page.locator('.bank-q-input').fill('富士山は日本一高い山である')
  await host.page.locator('.bank-ox-select').selectOption('o')
  await host.page.getByRole('button', { name: '追加する' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(1)

  // 「編集」を押すとフォームに値が入った状態で開く
  await host.page.locator('.bank-row').getByRole('button', { name: '編集' }).click()
  await expect(host.page.locator('.bank-q-input')).toHaveValue('富士山は日本一高い山である')
  await expect(host.page.locator('.bank-type-select')).toHaveValue('ox')
  await expect(host.page.locator('.bank-ox-select')).toHaveValue('o')
  await expect(host.page.locator('.bank-row')).toHaveClass(/\bediting\b/) // 編集中が一覧でも分かる

  // 書き換えて保存 → 一覧に反映され、増えない
  await host.page.locator('.bank-q-input').fill('富士山は世界一高い山である')
  await host.page.locator('.bank-ox-select').selectOption('x')
  await host.page.getByRole('button', { name: '保存する' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(1)
  await expect(host.page.locator('.bank-row')).toContainText('富士山は世界一高い山である')
  await expect(host.page.locator('.bank-row')).toContainText('答え: ×')
  // 保存後は新規追加のフォームに戻る
  await expect(host.page.getByRole('button', { name: '追加する' })).toBeVisible()

  await host.context.close()
})

test('問題集の絞り込み: 形式と文字列で一覧を狭められ、解除で元に戻る', async ({ browser }) => {
  // 部屋を開かない編集専用ページで確認する（絞り込みは通信に関係しない）
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/')
  await page.getByRole('button', { name: '問題集を編集する' }).click()

  // お試し用の問題をまとめて入れる
  await page.getByRole('button', { name: 'まとめて入れる・持ち出す' }).click()
  await page.getByRole('button', { name: /お試し用の問題/ }).click()
  await page.locator('.io-overlay .overlay-close').click()
  const all = SAMPLE_QUESTIONS.length
  await expect(page.locator('.bank-row')).toHaveCount(all)
  // 絞り込んでいないうちは件数表示を出さない
  await expect(page.locator('.bank-filter-status')).toBeHidden()

  // 形式で絞る
  await page.locator('.bank-filter-type').selectOption('ox')
  const oxCount = SAMPLE_QUESTIONS.filter((q) => q.type === 'ox').length
  await expect(page.locator('.bank-row')).toHaveCount(oxCount)
  await expect(page.locator('.bank-filter-status')).toContainText(`${oxCount}問 / 全${all}問`)
  await expect(page.locator('.type-badge').first()).toHaveText('○×')

  // 文字列で絞る（形式の条件と同時に効く）
  await page.locator('.bank-filter-type').selectOption('')
  await page.locator('.bank-filter-text').fill('日本')
  const hits = await page.locator('.bank-row').count()
  expect(hits).toBeGreaterThan(0)
  expect(hits).toBeLessThan(all)

  // 一致なしのときは案内を出す
  await page.locator('.bank-filter-text').fill('該当しないはずの文字列')
  await expect(page.locator('.bank-row')).toHaveCount(0)
  await expect(page.getByText('見つかりませんでした')).toBeVisible()

  // 解除で全件に戻る
  await page.getByRole('button', { name: '絞り込みを解除' }).click()
  await expect(page.locator('.bank-row')).toHaveCount(all)
  await expect(page.locator('.bank-filter-status')).toBeHidden()

  await context.close()
})

test('4択問題: 問題集に登録して出題すると選択肢が配信され、正解を1タップで発表できる', async ({ browser }) => {
  const host = await createRoom(browser)
  const p1 = await joinPlayer(browser, host.code, 'たろう')

  // 4択の問題を登録（形式を選ぶと入力欄が選択肢+正解番号に変わる）
  await host.page.getByRole('button', { name: '問題集から選ぶ' }).click()
  await host.page.locator('.form-toggle').click()
  await host.page.locator('.bank-type-select').selectOption('choice4')
  await host.page.locator('.bank-q-input').fill('日本の都道府県はいくつ？')
  const choices = ['43', '45', '47', '49']
  for (const [i, value] of choices.entries()) {
    await host.page.locator('.bank-choice-input').nth(i).fill(value)
  }
  await host.page.locator('.bank-correct-select').selectOption('3')
  await host.page.getByRole('button', { name: '追加する' }).click()
  await host.page.locator('.form-toggle').click() // 追加フォームを閉じて一覧を見る

  // 「選ぶ」で回答形式が4択に切り替わり、選択肢と正解が入力欄に読み込まれる
  await host.page.locator('.bank-row').getByRole('button', { name: '選ぶ' }).click()
  await expect(host.page.locator('.ask-choice-input').nth(2)).toHaveValue('47')
  await expect(host.page.locator('.ask-correct-select')).toHaveValue('3')

  // 出題すると選択肢が回答者に届く
  await host.page.getByRole('button', { name: '全員に出題' }).click()
  await expect(p1.page.locator('.answer-btn').nth(2)).toContainText('47')
  await host.page.waitForTimeout(2200)
  await host.page.getByRole('button', { name: '回答受付開始' }).click()

  // 回答 → 締め切り → 正解は問題集から分かっているので1タップで発表できる
  await p1.page.locator('.answer-btn').nth(2).click()
  await host.page.getByRole('button', { name: '締め切り' }).click()
  await host.page.getByRole('button', { name: '正解を発表（3. 47）' }).click()
  await expect(p1.page.locator('.me-summary')).toContainText('1点')

  // 問題集の履歴にも正解者が残る
  await host.page.getByRole('button', { name: '問題集から選ぶ' }).click()
  await expect(host.page.locator('.bank-row')).toContainText('たろう')

  await p1.context.close()
  await host.context.close()
})
