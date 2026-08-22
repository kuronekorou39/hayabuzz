// assets-src/bg-1.jpg, bg-2.jpg（各2x2グリッドの夜景）を4分割し、
// 背景用スプライトとして public/bg/ に WebP + JPEG で出力する。
// 実行: node scripts/extract-backgrounds.mjs
// ※ bg-3.jpg（水彩・明るい）はダークテーマと合わないため未使用（ライトテーマ用に温存）
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = resolve(root, 'public/bg')
const SOURCES = ['bg-1.jpg', 'bg-2.jpg']
const OUT_WIDTH = 1280
const INSET = 0.02 // グリッドの境界線を避ける切り込み

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--disable-features=NetworkServiceSandbox'],
})

try {
  const page = await browser.newPage()
  await page.goto('about:blank')
  await mkdir(OUT_DIR, { recursive: true })

  let index = 0
  for (const source of SOURCES) {
    const srcUrl = `data:image/jpeg;base64,${(await readFile(resolve(root, 'assets-src', source))).toString('base64')}`
    for (const row of [0, 1]) {
      for (const col of [0, 1]) {
        index += 1
        const dataUrls = await page.evaluate(
          async ({ src, row, col, outWidth, inset }) => {
            const img = new Image()
            img.src = src
            await img.decode()
            const qw = img.naturalWidth / 2
            const qh = img.naturalHeight / 2
            const sx = col * qw + qw * inset
            const sy = row * qh + qh * inset
            const sw = qw * (1 - inset * 2)
            const sh = qh * (1 - inset * 2)
            const outHeight = Math.round((outWidth * sh) / sw)
            const c = document.createElement('canvas')
            c.width = outWidth
            c.height = outHeight
            const ctx = c.getContext('2d')
            ctx.imageSmoothingQuality = 'high'
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outWidth, outHeight)
            return { webp: c.toDataURL('image/webp', 0.8), jpg: c.toDataURL('image/jpeg', 0.78) }
          },
          { src: srcUrl, row, col, outWidth: OUT_WIDTH, inset: INSET },
        )
        for (const [ext, dataUrl] of Object.entries(dataUrls)) {
          const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
          await writeFile(resolve(OUT_DIR, `bg-${index}.${ext}`), buf)
          console.log(`bg-${index}.${ext} (${(buf.length / 1024).toFixed(0)} KB)`)
        }
      }
    }
  }
} finally {
  await browser.close()
}
