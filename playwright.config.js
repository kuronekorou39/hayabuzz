import { defineConfig } from '@playwright/test'

// E2E_BASE_URL を指定すると公開環境（GitHub Pages 等）に対して実行する。
// 未指定ならローカルの dev サーバを自動起動してテストする。
const liveUrl = process.env.E2E_BASE_URL
const baseURL = liveUrl ?? 'http://127.0.0.1:5173/'

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000, // トラッカー経由のピア発見に時間がかかることがある
  workers: 1, // 部屋ごとに独立だが、負荷とトラッカー接続を安定させるため直列実行
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  expect: { timeout: 15_000 }, // 状態は host からの配信で反映されるため余裕を持つ
  use: {
    baseURL,
    // Playwright 同梱の chromium を使う（channel: 'chrome' の安定版 Chrome は
    // Windows でテスト終了後にプロセスが残りランナーがハングすることがあった）。
    // 初回は `npx playwright install chromium` が必要。
    // Chrome の Network Service Sandbox が有効な環境でループバック接続を通すため
    launchOptions: { args: ['--disable-features=NetworkServiceSandbox'] },
  },
  webServer: liveUrl
    ? undefined
    : {
        // npm ラッパー経由だと Windows で終了時に子プロセスが残りテストランナーが
        // 長時間ハングするため、vite を直接起動する
        command: 'node node_modules/vite/bin/vite.js',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
      },
})
