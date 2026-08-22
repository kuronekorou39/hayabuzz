// 早押しボタン全スタイルのスクリーンショットを撮る目視QA用スクリプト。
// dev サーバー起動中に: node scripts/shoot-buzzer-styles.mjs [出力先ディレクトリ]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const BASE = process.env.BASE ?? 'http://localhost:5173/'
const OUT = process.argv[2] ?? 'shots'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ args: ['--disable-features=NetworkServiceSandbox'] })

const hostCtx = await browser.newContext({ viewport: { width: 480, height: 900 } })
const host = await hostCtx.newPage()
await host.goto(BASE)
await host.getByRole('button', { name: '出題者として部屋を作る' }).click()
const code = (await host.locator('.room-code').textContent()).trim()
await host.getByRole('button', { name: 'クイズを開始' }).click()

// armed 中のグローの点滅を止めて静止画で比較できるよう reducedMotion にする
const playerCtx = await browser.newContext({ viewport: { width: 390, height: 780 }, reducedMotion: 'reduce' })
const player = await playerCtx.newPage()
await player.goto(`${BASE}#/join/${code}`)
await player.locator('input[placeholder="ニックネーム"]').fill('チューナー')
await player.getByRole('button', { name: '参加する' }).click()
await player.locator('.conn-overlay').waitFor({ state: 'hidden', timeout: 60_000 })

await host.locator('.question-input').fill('調整用の問題です')
await host.getByRole('button', { name: '問題を表示' }).click()
await host.waitForTimeout(2500)
await host.getByRole('button', { name: '早押し開始' }).click()
await player.locator('.buzzer.armed').waitFor({ timeout: 10_000 })

const openSettings = () => player.getByRole('button', { name: '設定' }).click()
const closeSettings = () => player.locator('.settings-overlay').click({ position: { x: 5, y: 5 } })

// 設定ポップアップ（スウォッチグリッド）の全景
await openSettings()
await player.waitForTimeout(400)
await player.screenshot({ path: join(OUT, 'settings.png') })

const ids = ['classic', 'red', 'blue', 'yellow', 'green', 'silver', 'wood', 'glass']
for (const id of ids) {
  await openSettings().catch(() => {})
  await player.locator(`.style-swatch[data-style="${id}"]`).click()
  await closeSettings()
  // スプライト画像の読み込み完了を待ってから撮る
  await player.waitForFunction(() =>
    [...document.querySelectorAll('.buzzer img')].every((img) => img.complete && img.naturalWidth > 0))
  await player.waitForTimeout(150)
  await player.locator('.buzzer').screenshot({ path: join(OUT, `buzzer-${id}.png`) })
}

await browser.close()
console.log(`done: ${OUT}`)
