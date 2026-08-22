import { expect, test } from '@playwright/test'
import { askAndArm, createRoom, joinPlayer, pressBuzzer } from './helpers.js'

test('基本フロー: 参加→出題→早押し→正解→再接続→部屋終了', async ({ browser }) => {
  const host = await createRoom(browser)

  const p1 = await joinPlayer(browser, host.code, 'たろう')
  await expect(host.page.locator('.score-nick', { hasText: 'たろう' })).toBeVisible()

  // ゲーム進行中でも「共有」からルームコードとQRを表示できる（途中参加者向け）。
  // ポップアップは範囲外タップで閉じられる
  await host.page.getByRole('button', { name: '共有' }).click()
  await expect(host.page.locator('.share-overlay .room-code')).toHaveText(host.code)
  await host.page.locator('.share-overlay').click({ position: { x: 10, y: 10 } })
  await expect(host.page.locator('.share-overlay')).toBeHidden()

  // 回答者の設定もポップアップで開き、範囲外タップで閉じる
  await p1.page.getByRole('button', { name: '設定' }).click()
  await expect(p1.page.locator('.settings-overlay')).toBeVisible()
  await p1.page.locator('.settings-overlay').click({ position: { x: 10, y: 10 } })
  await expect(p1.page.locator('.settings-overlay')).toBeHidden()

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
  await expect(p1.page.locator('.toast.ok', { hasText: '正解！ +1点' })).toBeVisible()
  await expect(p1.page.locator('.me-summary')).toContainText('1点')

  // 一時切断→再接続（リロード）で同一セッションIDにより得点を引き継ぐ
  await p1.page.reload()
  await p1.page.locator('input[placeholder="ニックネーム"]').fill('たろう')
  await p1.page.getByRole('button', { name: '参加する' }).click()
  await expect(p1.page.locator('.conn-overlay')).toBeHidden({ timeout: 60_000 })
  await expect(p1.page.locator('.me-summary')).toContainText('1点')

  // host 切断で player に部屋の終了を明示する
  await host.context.close()
  await expect(p1.page.locator('.conn-overlay')).toContainText('部屋が終了しました', { timeout: 30_000 })

  await p1.context.close()
})

test('タブを閉じて別セッションになっても、同名なら得点を引き継いで再入場できる', async ({ browser }) => {
  const host = await createRoom(browser)

  const p1 = await joinPlayer(browser, host.code, 'たろう')
  await askAndArm(host, '1問目')
  await expect(p1.page.locator('.buzzer')).toHaveClass(/\barmed\b/)
  await pressBuzzer(p1.page)
  await expect(host.page.locator('.badge.active')).toBeVisible()
  await host.page.getByRole('button', { name: '正解', exact: true }).click()
  await expect(p1.page.locator('.me-summary')).toContainText('1点')

  // タブを閉じる（sessionStorage が消える＝新しい sessionId になる）
  await p1.context.close()
  await expect(host.page.locator('.score-row .dot.off')).toBeVisible({ timeout: 20_000 })

  // 新しいコンテキスト（別端末相当）から同じ名前で入り直す
  const p2 = await joinPlayer(browser, host.code, 'たろう')
  await expect(p2.page.locator('.me-summary')).toContainText('1点')
  // 別人として増えず、同一プレイヤーとして扱われる
  await expect(host.page.locator('.score-row')).toHaveCount(1)
  await expect(host.page.locator('.score-row .dot.on')).toBeVisible()

  await p2.context.close()
  await host.context.close()
})
