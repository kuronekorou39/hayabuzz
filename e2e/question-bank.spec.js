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
  await host.page.getByRole('button', { name: 'セットから次を出題' }).click()
  await expect(p1.page.locator('.question-text')).toContainText('富士山の標高は？')
  await expect(host.page.locator('.answer-note')).toContainText('答え: 3776m')
  await expect(host.page.locator('.answer-note')).toContainText('メートル単位で回答')
  // player 側には答えは一切表示されない（DOM 全体に含まれない）
  await expect(p1.page.locator('body')).not.toContainText('3776m')

  // 出題済みになったので「セットから次を出題」は無効になる
  await expect(host.page.getByRole('button', { name: 'セットから次を出題' })).toBeDisabled()

  // 判定まで進めると出題履歴に正解者名が残る
  await host.page.waitForTimeout(2200)
  await host.page.getByRole('button', { name: '早押し開始' }).click()
  await expect(p1.page.locator('.buzzer')).toHaveClass(/\barmed\b/)
  await pressBuzzer(p1.page)
  await expect(p1.page.locator('.buzzer-label')).toHaveText('回答してください！')
  await host.page.getByRole('button', { name: '正解', exact: true }).click()

  await host.page.getByRole('button', { name: 'セット', exact: true }).click()
  await expect(host.page.locator('.bank-row')).toContainText('たろう')
  await expect(host.page.locator('.bank-row')).toContainText('1回')

  // スプレッドシート形式（タブ区切り）の貼り付け取り込み
  await host.page.locator('.bank-paste').fill('Q2\tA2\nQ3\tA3\tメモ3')
  await host.page.getByRole('button', { name: '取り込み' }).click()
  await expect(host.page.locator('.bank-row')).toHaveCount(3)

  await p1.context.close()
  await host.context.close()
})
