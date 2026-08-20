import { expect, test } from '@playwright/test'
import { askAndArm, createRoom, joinPlayer, pressBuzzer } from './helpers.js'

const LONG_QUESTION =
  '江戸時代の五街道のうち、江戸日本橋を起点として内陸を通り京都三条大橋へ至る街道は何でしょう？'

test('順次表示ルール: 読み上げが流れ、押下で止まり、正解で全文表示される', async ({ browser }) => {
  const host = await createRoom(browser)
  const p1 = await joinPlayer(browser, host.code, 'たろう')

  // ルール: 順次表示・ゆっくり（4文字/秒）
  await host.page.getByRole('button', { name: 'ルール' }).click()
  await host.page.locator('.settings-row', { hasText: '問題の表示' }).locator('select').selectOption('serial')
  await host.page.locator('.settings-row', { hasText: '読み上げ速度' }).locator('select').selectOption('4')
  await host.page.locator('.rules-overlay').getByRole('button', { name: '閉じる' }).click()

  await host.page.locator('textarea').fill(LONG_QUESTION)
  await host.page.getByRole('button', { name: '問題を表示' }).click()
  // 受付開始前は本文がまだ見えない
  await expect(p1.page.locator('.question-text')).toContainText('読み上げられます')

  await host.page.waitForTimeout(2200) // 時刻同期（pingバースト）待ち
  await host.page.getByRole('button', { name: '早押し開始' }).click()
  await expect(p1.page.locator('.buzzer')).toHaveClass(/\barmed\b/)

  // 読み上げが進む（ゆっくり設定なので全文にはならない）
  await p1.page.waitForTimeout(1500)
  const partial = (await p1.page.locator('.question-text').textContent()).trim()
  expect(partial.length).toBeGreaterThanOrEqual(2)
  expect(partial.length).toBeLessThan(LONG_QUESTION.length)
  expect(LONG_QUESTION.startsWith(partial)).toBe(true)

  // 押下で読み上げが止まる（凍結位置は host が権威として配信する）
  await pressBuzzer(p1.page)
  await expect(p1.page.locator('.buzzer-label')).toHaveText('回答してください！')
  await p1.page.waitForTimeout(300)
  const frozen1 = await p1.page.locator('.question-text').textContent()
  await p1.page.waitForTimeout(1000)
  const frozen2 = await p1.page.locator('.question-text').textContent()
  expect(frozen2).toBe(frozen1)
  expect(frozen2.length).toBeLessThan(LONG_QUESTION.length)

  // 正解が出たら全文が表示される
  await host.page.getByRole('button', { name: '正解', exact: true }).click()
  await expect(p1.page.locator('.question-text')).toHaveText(LONG_QUESTION)

  await p1.context.close()
  await host.context.close()
})

test('チーム戦: 自動割り当て・他チームへの開放・チーム合計と得点ルール', async ({ browser }) => {
  test.setTimeout(300_000)
  const host = await createRoom(browser)
  const p1 = await joinPlayer(browser, host.code, 'たろう')
  const p2 = await joinPlayer(browser, host.code, 'はなこ')
  const p3 = await joinPlayer(browser, host.code, 'じろう')

  // ルール: 2チーム + 正解は+3点
  await host.page.getByRole('button', { name: 'ルール' }).click()
  await host.page.locator('.settings-row', { hasText: 'チーム戦' }).locator('select').selectOption('2')
  await host.page.locator('.settings-row', { hasText: '正解の得点' }).locator('select').selectOption('3')
  await host.page.locator('.rules-overlay').getByRole('button', { name: '閉じる' }).click()

  // 参加順で 赤/青/赤 に割り当てられる
  await expect(host.page.locator('.score-row', { hasText: 'たろう' }).locator('.team-chip')).toHaveText('赤')
  await expect(host.page.locator('.score-row', { hasText: 'はなこ' }).locator('.team-chip')).toHaveText('青')
  await expect(host.page.locator('.score-row', { hasText: 'じろう' }).locator('.team-chip')).toHaveText('赤')

  // 赤のたろうが押して誤答 → 他チームに開放 → 赤チーム全員が除外され、青だけ押せる
  await askAndArm(host, 'チーム戦テスト')
  await expect(p1.page.locator('.buzzer')).toHaveClass(/\barmed\b/)
  await pressBuzzer(p1.page)
  await expect(p1.page.locator('.buzzer-label')).toHaveText('回答してください！')
  await host.page.getByRole('button', { name: '不正解→他チームに開放' }).click()
  await expect(p1.page.locator('.buzzer-label')).toHaveText('誤答のため待機')
  await expect(p3.page.locator('.buzzer-label')).toHaveText('誤答のため待機')
  await expect(p2.page.locator('.buzzer')).toHaveClass(/\barmed\b/)

  // 青のはなこが正解 → +3点。チーム合計にも反映される
  await pressBuzzer(p2.page)
  await expect(p2.page.locator('.buzzer-label')).toHaveText('回答してください！')
  await host.page.getByRole('button', { name: '正解', exact: true }).click()
  await expect(p2.page.locator('.me-summary')).toContainText('3点')
  await expect(host.page.locator('.team-totals .team-chip', { hasText: '青' })).toContainText('3点')
  await expect(host.page.locator('.team-totals .team-chip', { hasText: '赤' })).toContainText('0点')

  for (const p of [p1, p2, p3]) await p.context.close()
  await host.context.close()
})

test('同名復帰ルールを無効にすると、同名でも別プレイヤーとして扱われる', async ({ browser }) => {
  const host = await createRoom(browser)

  await host.page.getByRole('button', { name: 'ルール' }).click()
  await host.page.locator('.settings-row', { hasText: '同名での復帰' }).locator('input').uncheck()
  await host.page.locator('.rules-overlay').getByRole('button', { name: '閉じる' }).click()

  const p1 = await joinPlayer(browser, host.code, 'たろう')
  await askAndArm(host, '1問目')
  await expect(p1.page.locator('.buzzer')).toHaveClass(/\barmed\b/)
  await pressBuzzer(p1.page)
  await expect(host.page.locator('.badge.active')).toBeVisible()
  await host.page.getByRole('button', { name: '正解', exact: true }).click()
  await expect(p1.page.locator('.me-summary')).toContainText('1点')

  await p1.context.close()
  await expect(host.page.locator('.score-row .dot.off')).toBeVisible({ timeout: 20_000 })

  // ルール無効なので、同名でも新しいプレイヤーとして参加する（得点は引き継がれない）
  const p2 = await joinPlayer(browser, host.code, 'たろう')
  await expect(p2.page.locator('.me-summary')).toContainText('0点')
  await expect(host.page.locator('.score-row')).toHaveCount(2)

  await p2.context.close()
  await host.context.close()
})
