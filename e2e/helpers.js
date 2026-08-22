import { expect } from '@playwright/test'

// 出題者として部屋を作り、ロビー（共有画面）からゲーム進行画面へ進む。
// 専用のブラウザコンテキスト（=別端末相当）を割り当てる
export async function createRoom(browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('./')
  await page.getByRole('button', { name: '出題者として部屋を作る' }).click()
  const code = (await page.locator('.room-code').textContent()).trim()
  expect(code).toMatch(/^[A-Z0-9]{4}$/)
  await page.getByRole('button', { name: 'クイズを開始' }).click()
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

// 早押しボタンを押す。タッチエミュレーション中の端末は tap（タッチイベント経路）で押す
export async function pressBuzzer(page) {
  const isTouch = await page.evaluate(() => 'ontouchstart' in window)
  if (isTouch) await page.locator('.buzzer').tap()
  else await page.locator('.buzzer').click()
}

// 問題を出して早押し受付を開始する
export async function askAndArm(host, questionText) {
  await host.page.locator('.question-input').fill(questionText)
  await host.page.getByRole('button', { name: '問題を表示' }).click()
  // welcome 直後の ping バースト（8回×150ms）でクロックオフセット推定が済むのを待つ
  await host.page.waitForTimeout(2500)
  await host.page.getByRole('button', { name: '早押し開始' }).click()
}
