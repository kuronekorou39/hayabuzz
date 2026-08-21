import { expect, test } from '@playwright/test'
import { createRoom, joinPlayer } from './helpers.js'

test('○×クイズ: 一斉回答→締め切り→正答発表で自動採点される', async ({ browser }) => {
  test.setTimeout(300_000)
  const host = await createRoom(browser)
  const p1 = await joinPlayer(browser, host.code, 'たろう')
  const p2 = await joinPlayer(browser, host.code, 'はなこ')

  // ルール: 回答形式=○×
  await host.page.getByRole('button', { name: 'ルール' }).click()
  await host.page.locator('.settings-row', { hasText: '回答形式' }).locator('select').selectOption('ox')
  await host.page.locator('.rules-overlay').getByRole('button', { name: '閉じる' }).click()

  // 出題 → 回答受付開始
  await host.page.locator('.question-input').fill('富士山は世界一高い山である。○か×か')
  await host.page.getByRole('button', { name: '問題を表示' }).click()
  await host.page.getByRole('button', { name: '回答受付開始' }).click()

  // 各自がタップで回答（締切まで変更可）。host には人数だけ見える
  await expect(p1.page.getByRole('button', { name: '○' })).toBeEnabled()
  await p1.page.getByRole('button', { name: '○' }).click()
  await p2.page.getByRole('button', { name: '×' }).click()
  await expect(host.page.locator('.answers-line')).toHaveText('回答済み 2/2人')

  // 締め切り → 回答一覧が見える
  await host.page.getByRole('button', { name: '締め切り' }).click()
  await expect(host.page.locator('.order-row', { hasText: 'たろう' })).toContainText('○')
  await expect(host.page.locator('.order-row', { hasText: 'はなこ' })).toContainText('×')
  await expect(p1.page.getByRole('button', { name: '○' })).toBeDisabled()

  // 正答発表 → 自動採点・結果表示
  await host.page.getByRole('button', { name: '正解は×' }).click()
  await expect(host.page.locator('.result-line')).toContainText('正解は×（1人正解）')
  await expect(p2.page.locator('.toast.ok', { hasText: '正解！ +1点' })).toBeVisible()
  await expect(p1.page.locator('.toast.ng', { hasText: '不正解…' })).toBeVisible()
  await expect(p2.page.locator('.me-summary')).toContainText('1点')
  await expect(p1.page.locator('.me-summary')).toContainText('0点')

  for (const p of [p1, p2]) await p.context.close()
  await host.context.close()
})

test('結果発表: 最終ランキングが全端末に表示され、ゲームに戻れる', async ({ browser }) => {
  const host = await createRoom(browser)
  const p1 = await joinPlayer(browser, host.code, 'たろう')

  // 手動で1点付与してから結果発表
  await host.page.locator('.score-row', { hasText: 'たろう' }).getByRole('button', { name: '＋' }).click()
  await host.page.getByRole('button', { name: '結果発表' }).click()
  await expect(p1.page.locator('.final-overlay')).toBeVisible()
  await expect(p1.page.locator('.final-overlay .board-row', { hasText: 'たろう' })).toContainText('1点')
  await expect(p1.page.locator('.final-overlay .final-rank')).toHaveText('1位')

  // ゲームに戻ると結果発表は閉じる
  await host.page.getByRole('button', { name: 'ゲームに戻る' }).click()
  await expect(p1.page.locator('.final-overlay')).toBeHidden()

  await p1.context.close()
  await host.context.close()
})
