import { expect, test } from '@playwright/test'
import { askAndArm, createRoom, joinPlayer, pressBuzzer } from './helpers.js'

test('基本フロー: 参加→出題→早押し→正解→再接続→部屋終了', async ({ browser }) => {
  const host = await createRoom(browser)

  const p1 = await joinPlayer(browser, host.code, 'たろう')
  await expect(host.page.locator('.score-nick', { hasText: 'たろう' })).toBeVisible()

  // ゲーム進行中でも「共有」からルームコードとQRを表示できる（途中参加者向け）
  await host.page.getByRole('button', { name: '共有' }).click()
  await expect(host.page.locator('.share-overlay .room-code')).toHaveText(host.code)
  await host.page.locator('.share-overlay').getByRole('button', { name: '閉じる' }).click()
  await expect(host.page.locator('.share-overlay')).toBeHidden()

  await askAndArm(host, '日本の首都は？')
  await expect(p1.page.locator('.question-text')).toContainText('日本の首都は？')
  await expect(p1.page.locator('.buzzer')).toHaveClass(/\barmed\b/)

  await pressBuzzer(p1.page)
  await expect(host.page.locator('.order-row', { hasText: 'たろう' })).toBeVisible()
  // 1位からのms差の表示形式
  await expect(host.page.locator('.order-delta').first()).toHaveText(/^\+\d+(\.\d+)?ms$/)
  // 回答権が回り、player 側もロック表示になる
  await expect(host.page.locator('.badge.active')).toBeVisible()
  await expect(p1.page.locator('.buzzer-label')).toHaveText('回答してください！')

  await host.page.getByRole('button', { name: '正解', exact: true }).click()
  await expect(p1.page.locator('.result-banner.ok')).toContainText('正解！ +1点')
  await expect(p1.page.locator('.stat', { hasText: '得点' })).toHaveText('得点 1')

  // 一時切断→再接続（リロード）で同一セッションIDにより得点を引き継ぐ
  await p1.page.reload()
  await p1.page.locator('input[placeholder="ニックネーム"]').fill('たろう')
  await p1.page.getByRole('button', { name: '参加する' }).click()
  await expect(p1.page.locator('.overlay')).toBeHidden({ timeout: 60_000 })
  await expect(p1.page.locator('.stat', { hasText: '得点' })).toHaveText('得点 1')

  // host 切断で player に部屋の終了を明示する
  await host.context.close()
  await expect(p1.page.locator('.overlay')).toContainText('部屋が終了しました', { timeout: 30_000 })

  await p1.context.close()
})
