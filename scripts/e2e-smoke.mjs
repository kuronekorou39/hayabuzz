// E2E スモークテスト（Playwright + インストール済み Chrome を使用）
// 前提: `npm run dev` が起動していること。実行: `npm run e2e`
// 検証内容: 部屋作成 → 参加 → 出題 → 早押し → 正解判定 → 得点反映 →
//           再接続での得点引き継ぎ → host 切断時の「部屋が終了しました」表示
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:5173/'
const log = (m) => console.log(`[e2e] ${m}`)

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  // Chrome のネットワークサービスサンドボックスが有効な環境では
  // ループバック(dev サーバ)へ接続できないため無効化する
  args: ['--disable-features=NetworkServiceSandbox'],
})

try {
  // --- host: 部屋を作る ---
  const hostCtx = await browser.newContext()
  const host = await hostCtx.newPage()
  await host.goto(BASE)
  await host.getByRole('button', { name: '出題者として部屋を作る' }).click()
  const code = (await host.locator('.room-code').textContent()).trim()
  if (!/^[A-Z0-9]{10}$/.test(code)) throw new Error(`ルームコード形式が想定外: ${code}`)
  log(`ルームコード: ${code}`)

  // --- player: QR 相当の直リンクで参加 ---
  const playerCtx = await browser.newContext()
  const player = await playerCtx.newPage()
  await player.goto(`${BASE}#/join/${code}`)
  await player.locator('input[placeholder="ニックネーム"]').fill('たろう')
  await player.getByRole('button', { name: '参加する' }).click()
  await player.locator('.overlay').waitFor({ state: 'hidden', timeout: 60000 })
  log('player 参加成功（welcome 受信、オーバーレイ消滅）')

  await host.locator('.score-nick', { hasText: 'たろう' }).waitFor({ timeout: 15000 })
  log('host の得点表に player が表示された')

  // --- 出題 → 早押し受付 ---
  await host.locator('textarea').fill('日本の首都は？')
  await host.getByRole('button', { name: '問題を表示' }).click()
  await player.locator('.question-text', { hasText: '日本の首都は？' }).waitFor({ timeout: 10000 })
  log('player に問題文が配信された')

  // ping バースト（8回×150ms）でオフセット推定が済むまで少し待つ
  await player.waitForTimeout(2500)

  await host.getByRole('button', { name: '早押し開始' }).click()
  await player.locator('.buzzer.armed').waitFor({ timeout: 10000 })
  log('player のボタンが受付中になった')

  await player.locator('.buzzer').click()
  await host.locator('.order-row', { hasText: 'たろう' }).waitFor({ timeout: 10000 })
  const delta = (await host.locator('.order-delta').first().textContent()).trim()
  if (!/^\+\d+(\.\d+)?ms$/.test(delta)) throw new Error(`ms差の表示が想定外: ${delta}`)
  log(`押下が順位リストに載った（1位 ${delta}）`)

  // --- 判定 → 得点反映 ---
  await host.getByRole('button', { name: '正解', exact: true }).click()
  await player.locator('.result-banner.ok').waitFor({ timeout: 10000 })
  await player.locator('.stat', { hasText: '得点 1' }).waitFor({ timeout: 10000 })
  log('正解判定が player に届き得点 1 になった')

  // --- 再接続（リロード）で得点引き継ぎ ---
  await player.reload()
  await player.locator('input[placeholder="ニックネーム"]').fill('たろう')
  await player.getByRole('button', { name: '参加する' }).click()
  await player.locator('.overlay').waitFor({ state: 'hidden', timeout: 60000 })
  await player.locator('.stat', { hasText: '得点 1' }).waitFor({ timeout: 15000 })
  log('再接続で得点を引き継いだ（得点 1 のまま）')

  // --- host 切断 → 部屋終了の明示 ---
  await hostCtx.close()
  await player.locator('.overlay', { hasText: '部屋が終了しました' }).waitFor({ timeout: 30000 })
  log('host 切断で player に「部屋が終了しました」が表示された')

  console.log('[e2e] PASS: 全チェックポイント通過')
} catch (err) {
  console.error('[e2e] FAIL:', err.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
