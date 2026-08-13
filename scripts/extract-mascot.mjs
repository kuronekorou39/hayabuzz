// assets-src/mascot-quiz-hayato.png（3x3 のポーズシート）からマスコット素材を切り出す。
// 実行: node scripts/extract-mascot.mjs
// 出力: src/assets/mascot/*.webp（アプリ内表示用）と public/favicon.png, public/apple-touch-icon.png
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(root, 'assets-src', 'mascot-quiz-hayato.png')
const OUT_DIR = resolve(root, 'src/assets/mascot')
const PUBLIC_DIR = resolve(root, 'public')

// 3x3 グリッドの (行, 列) → 用途
const CELLS = [
  { row: 0, col: 1, name: 'flying', out: 320 }, // 飛んでいる → 接続中
  { row: 1, col: 0, name: 'correct', out: 320 }, // 正解!（トロフィー） → 正解バナー
  { row: 2, col: 1, name: 'wrong', out: 320 }, // ??（困り顔） → 不正解/エラー
  { row: 2, col: 0, name: 'hero', out: 480 }, // ボタンを持つ → トップ画面
]
const ICON_CELL = { row: 2, col: 2 } // 本を読む（メガネ） → アイコン

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--disable-features=NetworkServiceSandbox'],
})

try {
  const page = await browser.newPage()
  await page.goto('about:blank')
  const srcUrl = `data:image/png;base64,${(await readFile(SRC)).toString('base64')}`

  // パステル色のセル9枚を連結成分として検出し、行→列順に並べる
  const cells = await page.evaluate(async (src) => {
    const img = new Image()
    img.src = src
    await img.decode()
    const scale = 0.5
    const w = Math.round(img.naturalWidth * scale)
    const h = Math.round(img.naturalHeight * scale)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, w, h)
    const d = ctx.getImageData(0, 0, w, h).data
    const mask = new Uint8Array(w * h)
    for (let i = 0; i < w * h; i++) {
      // 背景の白と薄いグレーの線を除外（パステルのセルは最小チャネルが十分低い）
      if (Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) < 232) mask[i] = 1
    }
    const labels = new Int32Array(w * h).fill(-1)
    const boxes = []
    const stack = []
    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || labels[start] !== -1) continue
      const id = boxes.length
      let minX = w, maxX = 0, minY = h, maxY = 0, area = 0
      stack.push(start)
      labels[start] = id
      while (stack.length) {
        const p = stack.pop()
        const x = p % w
        const y = (p / w) | 0
        area += 1
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (x > 0 && mask[p - 1] && labels[p - 1] === -1) { labels[p - 1] = id; stack.push(p - 1) }
        if (x < w - 1 && mask[p + 1] && labels[p + 1] === -1) { labels[p + 1] = id; stack.push(p + 1) }
        if (y > 0 && mask[p - w] && labels[p - w] === -1) { labels[p - w] = id; stack.push(p - w) }
        if (y < h - 1 && mask[p + w] && labels[p + w] === -1) { labels[p + w] = id; stack.push(p + w) }
      }
      boxes.push({ minX, maxX, minY, maxY, area })
    }
    // セルは大きな正方形（タイトル文字などの小さい成分を除外）
    const found = boxes
      .filter((b) => b.area > 20000)
      .map((b) => ({
        x: b.minX / scale,
        y: b.minY / scale,
        w: (b.maxX - b.minX + 1) / scale,
        h: (b.maxY - b.minY + 1) / scale,
      }))
    found.sort((a, b) => a.y - b.y)
    const rows = [found.slice(0, 3), found.slice(3, 6), found.slice(6, 9)]
    for (const row of rows) row.sort((a, b) => a.x - b.x)
    return rows
  }, srcUrl)

  const total = cells.flat().length
  console.log(`セル検出: ${total} 個`)
  if (total !== 9) throw new Error(`3x3 のセルが検出できなかった（${total} 個）`)

  // 指定セルを切り出す共通処理。radiusRatio > 0 なら角丸で透過を焼き込む
  const crop = (cell, out, type, radiusRatio = 0) =>
    page.evaluate(
      async ({ src, cell, out, type, radiusRatio }) => {
        const img = new Image()
        img.src = src
        await img.decode()
        const inset = 0.015 // セル縁の白フチを避ける
        const sx = cell.x + cell.w * inset
        const sy = cell.y + cell.h * inset
        const sw = cell.w * (1 - inset * 2)
        const sh = cell.h * (1 - inset * 2)
        const c = document.createElement('canvas')
        c.width = out
        c.height = out
        const ctx = c.getContext('2d')
        ctx.imageSmoothingQuality = 'high'
        if (radiusRatio > 0) {
          ctx.beginPath()
          ctx.roundRect(0, 0, out, out, out * radiusRatio)
          ctx.clip()
        }
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, out, out)
        return c.toDataURL(type, 0.85)
      },
      { src: srcUrl, cell, out, type, radiusRatio },
    )

  await mkdir(OUT_DIR, { recursive: true })
  await mkdir(PUBLIC_DIR, { recursive: true })

  for (const spec of CELLS) {
    const dataUrl = await crop(cells[spec.row][spec.col], spec.out, 'image/webp')
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
    await writeFile(resolve(OUT_DIR, `${spec.name}.webp`), buf)
    console.log(`${spec.name}.webp (${(buf.length / 1024).toFixed(0)} KB)`)
  }

  const iconCell = cells[ICON_CELL.row][ICON_CELL.col]
  const favicon = await crop(iconCell, 256, 'image/png', 0.22)
  await writeFile(resolve(PUBLIC_DIR, 'favicon.png'), Buffer.from(favicon.split(',')[1], 'base64'))
  const touchIcon = await crop(iconCell, 180, 'image/png')
  await writeFile(resolve(PUBLIC_DIR, 'apple-touch-icon.png'), Buffer.from(touchIcon.split(',')[1], 'base64'))
  console.log('favicon.png / apple-touch-icon.png')

  // 目視確認用の一覧をスクリーンショット
  const files = [
    ...CELLS.map((s) => resolve(OUT_DIR, `${s.name}.webp`)),
    resolve(PUBLIC_DIR, 'favicon.png'),
  ]
  const imgs = []
  for (const f of files) {
    const ext = f.endsWith('.png') ? 'png' : 'webp'
    imgs.push(`<img src="data:image/${ext};base64,${(await readFile(f)).toString('base64')}"
      style="width:150px;border-radius:16px;">`)
  }
  await page.setContent(
    `<body style="margin:0;background:#10141a;display:flex;gap:12px;padding:16px;align-items:center;">${imgs.join('')}</body>`,
  )
  await page.waitForTimeout(300)
  const shot = resolve(root, 'assets-src', 'mascot-preview.png')
  await page.screenshot({ path: shot })
  console.log(`プレビュー: ${shot}`)
} finally {
  await browser.close()
}
