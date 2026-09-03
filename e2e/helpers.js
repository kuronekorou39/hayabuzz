import { expect } from '@playwright/test'

// 出題者として部屋を作る。最初から進行画面+共有ポップアップが開いた状態なので、
// ポップアップを閉じて進行画面を出す。専用のブラウザコンテキスト（=別端末相当）を割り当てる
export async function createRoom(browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('./')
  await page.getByRole('button', { name: '出題者として部屋を作る' }).click()
  const code = (await page.locator('.room-code').textContent()).trim()
  expect(code).toMatch(/^[A-Z0-9]{4}$/)
  await page.locator('.share-overlay').getByRole('button', { name: '閉じる' }).click()
  return { context, page, code }
}

// 回答者として参加する。contextOptions で端末エミュレーション（viewport/hasTouch 等）を指定できる
export async function joinPlayer(browser, code, nick, contextOptions = {}) {
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  await page.goto(`./#/join/${code}`)
  await page.locator('input[placeholder="ニックネーム"]').fill(nick)
  await page.getByRole('button', { name: '参加する' }).click()
  await expect(page.locator('.conn-overlay')).toBeHidden({ timeout: 60_000 })
  return { context, page, nick }
}

// 出題者の参加者・得点シートを開く（得点操作・履歴・結果発表はこの中にある）。
// 既に開いていれば何もしない
export async function openScoreSheet(page) {
  const sheet = page.locator('.score-sheet')
  if (await sheet.evaluate((n) => n.classList.contains('open'))) return
  await page.locator('.sheet-handle').click()
  await expect(sheet).toHaveClass(/\bopen\b/)
}

// 開いたままだと出題カードの操作を覆ってしまうので、用が済んだら閉じる
export async function closeScoreSheet(page) {
  const sheet = page.locator('.score-sheet')
  if (!(await sheet.evaluate((n) => n.classList.contains('open')))) return
  await page.locator('.sheet-handle').click()
  await expect(sheet).not.toHaveClass(/\bopen\b/)
}

// 早押しボタンを押す。タッチエミュレーション中の端末は tap（タッチイベント経路）で押す
export async function pressBuzzer(page) {
  const isTouch = await page.evaluate(() => 'ontouchstart' in window)
  if (isTouch) await page.locator('.buzzer').tap()
  else await page.locator('.buzzer').click()
}

// 問題を出す（表示と同時に早押し受付が始まる）。
// 前の問題の判定結果が出たままなら「次の問題へ」で閉じてから入力する。
// welcome 直後の ping バースト（8回×150ms）でクロックオフセット推定が済むまで待ってから出す
export async function askAndArm(host, questionText) {
  const next = host.page.getByRole('button', { name: '次の問題へ' })
  if ((await next.count()) > 0) await next.click()
  await host.page.locator('.question-input').fill(questionText)
  await host.page.waitForTimeout(2500)
  await host.page.getByRole('button', { name: '出題開始' }).click()
}
