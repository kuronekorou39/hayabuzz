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

  // 判定結果は「次の問題へ」を押すまで残る（入力欄は隠れ、問題・答え・押下順・結果が見える）
  await expect(host.page.locator('.question-input')).toBeHidden()
  await expect(host.page.locator('.result-line')).toContainText('正解: たろう')
  await expect(host.page.locator('.order-row', { hasText: 'たろう' })).toBeVisible()
  await expect(host.page.locator('.card-title .q-badge')).toHaveText('Q1')
  await host.page.getByRole('button', { name: '次の問題へ' }).click()
  await expect(host.page.locator('.question-input')).toBeVisible()
  await expect(host.page.locator('.question-input')).toHaveValue('')
  await expect(host.page.locator('.order-row')).toHaveCount(0)
  await expect(host.page.locator('.card-title .q-badge')).toHaveText('Q2')

  // 一時切断→再接続（リロード）で同一セッションIDにより得点を引き継ぐ。
  // 接続中のリロードには確認ダイアログ（leave-guard）が出るので受諾して進める
  p1.page.on('dialog', (dialog) => dialog.accept())
  await p1.page.reload()
  await p1.page.locator('input[placeholder="ニックネーム"]').fill('たろう')
  await p1.page.getByRole('button', { name: '参加する' }).click()
  await expect(p1.page.locator('.conn-overlay')).toBeHidden({ timeout: 60_000 })
  await expect(p1.page.locator('.me-summary')).toContainText('1点')

  // host 切断は player に明示する（出題者は復帰できるので「終了」とは言わず、戻りを待つ）。
  // 診断ログは畳まれていて、開くと見える
  await host.context.close()
  await expect(p1.page.locator('.conn-overlay')).toContainText('出題者との接続が切れました', { timeout: 30_000 })
  const diag = p1.page.locator('.conn-overlay .overlay-diag')
  await expect(diag.locator('.diag-log')).toBeHidden()
  await diag.locator('summary').click()
  await expect(diag.locator('.diag-log')).toContainText('ピア接続')

  await p1.context.close()
})

test('出題者がリロードしても同じ部屋に復帰でき、回答者は待っていれば自動でつながり直す', async ({ browser }) => {
  test.setTimeout(300_000)
  const host = await createRoom(browser)
  const p1 = await joinPlayer(browser, host.code, 'たろう')
  await askAndArm(host, '1問目')
  await expect(p1.page.locator('.buzzer')).toHaveClass(/\barmed\b/)
  await pressBuzzer(p1.page)
  await expect(host.page.locator('.badge.active')).toBeVisible()
  await host.page.getByRole('button', { name: '正解', exact: true }).click()
  await expect(p1.page.locator('.me-summary')).toContainText('1点')

  // 出題者がリロード（参加者がいるので確認ダイアログが出る）。URL の部屋と端末の保存から復帰する
  host.page.on('dialog', (dialog) => dialog.accept())
  await host.page.reload()
  await expect(host.page.locator('.toast.ok', { hasText: '前の部屋に戻りました' })).toBeVisible()
  await expect(host.page.locator('.share-overlay')).toBeHidden() // 復帰では共有ポップアップを開かない
  await expect(host.page.locator('.card-title .q-badge')).toHaveText('Q1') // 判定結果の表示中のまま復帰する
  // 回答者は出題者の戻りを待つ表示になり、戻ると自動でつながり直して得点も残っている
  await expect(p1.page.locator('.conn-overlay')).toContainText('出題者との接続が切れました', { timeout: 30_000 })
  await expect(p1.page.locator('.conn-overlay')).toBeHidden({ timeout: 60_000 })
  await expect(p1.page.locator('.toast.ok', { hasText: '出題者が戻りました' })).toBeVisible()
  await expect(p1.page.locator('.me-summary')).toContainText('1点')
  await expect(host.page.locator('.score-row', { hasText: 'たろう' }).locator('.dot.on')).toBeVisible()
  await expect(host.page.locator('.score-value')).toHaveText('1')

  // そのまま次の問題を続けられる
  await askAndArm(host, '2問目')
  await expect(p1.page.locator('.question-text')).toContainText('2問目')
  await expect(p1.page.locator('.buzzer')).toHaveClass(/\barmed\b/)

  // 出題者が「部屋を閉じる」と回答者には終了が伝わり、出題者はトップへ戻る（前の部屋には戻れない）
  await host.page.getByRole('button', { name: '設定' }).click()
  await host.page.getByRole('button', { name: '部屋を閉じる' }).click()
  await expect(p1.page.locator('.conn-overlay')).toContainText('部屋が終了しました', { timeout: 30_000 })
  await expect(host.page.getByRole('button', { name: '出題者として部屋を作る' })).toBeVisible()
  await expect(host.page.getByRole('button', { name: /前の部屋に戻る/ })).toHaveCount(0)

  await p1.context.close()
  await host.context.close()
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
