import { expect, test } from '@playwright/test'
import { SAMPLE_QUESTIONS } from '../src/game/sample-questions.js'
import { createRoom, joinPlayer, pressBuzzer } from './helpers.js'

test('問題セット: 追加→出題→答えの手元表示→正解者名の記録→貼り付け取り込み', async ({ browser }) => {
  const host = await createRoom(browser)
  const p1 = await joinPlayer(browser, host.code, 'たろう')

  // セットに1問追加（追加フォームは折りたたみの中）
  await host.page.getByRole('button', { name: 'セット', exact: true }).click()
  await host.page.getByText('問題を追加').click()
  await host.page.locator('.bank-q-input').fill('富士山の標高は？')
  await host.page.locator('.bank-a-input').fill('3776m')
  await host.page.locator('.bank-memo-input').fill('メートル単位で回答')
  await host.page.getByRole('button', { name: '追加' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(1)

  // セット一覧から選んで出題 → player に問題文が配信され、host には答え・メモが手元表示される
  await host.page.locator('.bank-row').getByRole('button', { name: '出題' }).click()
  await expect(p1.page.locator('.question-text')).toContainText('富士山の標高は？')
  await expect(p1.page.locator('.q-badge')).toHaveText('Q1')
  await expect(host.page.locator('.answer-note')).toContainText('答え: 3776m')
  await expect(host.page.locator('.answer-note')).toContainText('メートル単位で回答')
  // 出題中の問題文は入力欄に残る（編集はできない）
  await expect(host.page.locator('.question-input')).toHaveValue('富士山の標高は？')
  await expect(host.page.locator('.question-input')).toBeDisabled()
  // player 側には答えは一切表示されない（DOM 全体に含まれない）
  await expect(p1.page.locator('body')).not.toContainText('3776m')

  // 出題中はセットから選び直せない
  await host.page.getByRole('button', { name: 'セット', exact: true }).click()
  await expect(host.page.locator('.bank-row').getByRole('button', { name: '出題' })).toBeDisabled()
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

  await host.page.getByRole('button', { name: 'セット', exact: true }).click()
  await expect(host.page.locator('.bank-row')).toContainText('たろう')
  await expect(host.page.locator('.bank-row')).toContainText('1回')
  await host.page.locator('.bank-overlay').getByRole('button', { name: '閉じる' }).click()

  // セッションの出題履歴に問題・答え・正解者が残る
  await host.page.getByRole('button', { name: '履歴', exact: true }).click()
  await expect(host.page.locator('.history-overlay')).toContainText('富士山の標高は？')
  await expect(host.page.locator('.history-overlay')).toContainText('答え: 3776m')
  await expect(host.page.locator('.history-overlay')).toContainText('正解: たろう')
  await host.page.locator('.history-overlay').getByRole('button', { name: '閉じる' }).click()
  await host.page.getByRole('button', { name: 'セット', exact: true }).click()

  // スプレッドシート形式（タブ区切り）の貼り付け取り込み（折りたたみの中）
  await host.page.getByText('取り込み・書き出し').click()
  await host.page.locator('.bank-paste').fill('Q2\tA2\nQ3\tA3\tメモ3')
  await host.page.getByRole('button', { name: '取り込み', exact: true }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(3)

  // サンプルの取り込み（既存3問 + サンプル。再度押しても重複しない）
  const withSamples = 3 + SAMPLE_QUESTIONS.length
  await host.page.getByRole('button', { name: 'サンプルを取り込む' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(withSamples)
  await host.page.getByRole('button', { name: 'サンプルを取り込む' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(withSamples)

  await p1.context.close()
  await host.context.close()
})

test('4択問題: セットに登録して出題すると選択肢が配信され、正解を1タップで発表できる', async ({ browser }) => {
  const host = await createRoom(browser)
  const p1 = await joinPlayer(browser, host.code, 'たろう')

  // 4択の問題を登録（形式を選ぶと入力欄が選択肢+正解番号に変わる）
  await host.page.getByRole('button', { name: 'セット', exact: true }).click()
  await host.page.getByText('問題を追加').click()
  await host.page.locator('.bank-type-select').selectOption('choice4')
  await host.page.locator('.bank-q-input').fill('日本の都道府県はいくつ？')
  const choices = ['43', '45', '47', '49']
  for (const [i, value] of choices.entries()) {
    await host.page.locator('.bank-choice-input').nth(i).fill(value)
  }
  await host.page.locator('.bank-correct-select').selectOption('3')
  await host.page.getByRole('button', { name: '追加' }).click()
  await host.page.getByText('問題を追加').click() // 追加フォームを閉じて一覧を見る

  // 出題すると回答形式も4択に切り替わり、選択肢が回答者に届く
  await host.page.locator('.bank-row').getByRole('button', { name: '出題' }).click()
  await expect(host.page.locator('.answer-note')).toContainText('3. 47')
  await expect(p1.page.locator('.answer-btn').nth(2)).toContainText('47')
  await host.page.waitForTimeout(2200)
  await host.page.getByRole('button', { name: '回答受付開始' }).click()

  // 回答 → 締め切り → 正解はセットから分かっているので1タップで発表できる
  await p1.page.locator('.answer-btn').nth(2).click()
  await host.page.getByRole('button', { name: '締め切り' }).click()
  await host.page.getByRole('button', { name: '正解を発表（3. 47）' }).click()
  await expect(p1.page.locator('.me-summary')).toContainText('1点')

  // セットの履歴にも正解者が残る
  await host.page.getByRole('button', { name: 'セット', exact: true }).click()
  await expect(host.page.locator('.bank-row')).toContainText('たろう')

  await p1.context.close()
  await host.context.close()
})
