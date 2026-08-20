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
  preview: {
    // 本番ビルドに対する E2E 実行用（E2E_BASE_URL で指定）。
    // 4173 は他アプリと衝突しうるため専用ポートに固定する
    host: true,
    port: 4517,
    strictPort: true,
  },
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    // iPhone 6 (iOS 12 Safari) 等の旧端末でも動くよう、モダン構文
    // (?. / ?? / クラスのプライベートメソッド等) をトランスパイルする。
    // 足りないランタイムAPIは src/polyfills.js で補う
    target: 'safari12',
    cssTarget: 'safari12',
  },
  test: {
    // Playwright の e2e/*.spec.js を vitest が拾わないようユニットテストに限定する
    include: ['tests/**/*.test.js'],
  },
})
