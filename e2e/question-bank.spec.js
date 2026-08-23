import { expect, test } from '@playwright/test'
import { createRoom, joinPlayer, pressBuzzer } from './helpers.js'

test('問題セット: 追加→出題→答えの手元表示→正解者名の記録→貼り付け取り込み', async ({ browser }) => {
  const host = await createRoom(browser)
  const p1 = await joinPlayer(browser, host.code, 'たろう')

  // セットに1問追加
  await host.page.getByRole('button', { name: 'セット', exact: true }).click()
  await host.page.locator('.bank-q-input').fill('富士山の標高は？')
  await host.page.locator('.bank-a-input').fill('3776m')
  await host.page.locator('.bank-memo-input').fill('メートル単位で回答')
  await host.page.getByRole('button', { name: '追加' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(1)
  await host.page.locator('.bank-overlay').getByRole('button', { name: '閉じる' }).click()

  // セットから出題 → player に問題文が配信され、host には答え・メモが手元表示される
  await host.page.getByRole('button', { name: 'セットから出題' }).click()
  await expect(p1.page.locator('.question-text')).toContainText('富士山の標高は？')
  await expect(p1.page.locator('.q-badge')).toHaveText('Q1')
  await expect(host.page.locator('.answer-note')).toContainText('答え: 3776m')
  await expect(host.page.locator('.answer-note')).toContainText('メートル単位で回答')
  // player 側には答えは一切表示されない（DOM 全体に含まれない）
  await expect(p1.page.locator('body')).not.toContainText('3776m')

  // 未出題の問題がなくなったので「セットから出題」は消える
  await expect(host.page.getByRole('button', { name: 'セットから出題' })).toBeHidden()

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

  // スプレッドシート形式（タブ区切り）の貼り付け取り込み
  await host.page.locator('.bank-paste').fill('Q2\tA2\nQ3\tA3\tメモ3')
  await host.page.getByRole('button', { name: '取り込み' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(3)

  // サンプル20問の取り込み（既存3問 + 20問。再度押しても重複しない）
  await host.page.getByRole('button', { name: 'サンプル20問を取り込む' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(23)
  await host.page.getByRole('button', { name: 'サンプル20問を取り込む' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(23)

  await p1.context.close()
  await host.context.close()
})
