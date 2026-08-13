import { defineConfig } from 'vite'

export default defineConfig({
  // 相対パスにすることで GitHub Pages のサブディレクトリ配信
  // (https://<user>.github.io/<repo>/) にリポジトリ名非依存で対応する
  base: './',
  server: {
    // Node 17+ では localhost が ::1 に解決され IPv6 のみで待ち受けてしまうため、
    // 全インターフェースにバインドする（開発時のみの設定。スマホ実機での確認にも使える）
    host: true,
  },
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
  test: {
    // Playwright の e2e/*.spec.js を vitest が拾わないようユニットテストに限定する
    include: ['tests/**/*.test.js'],
  },
})
