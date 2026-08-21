// assets-src/ の参考画像から早押しボタンのスプライト（台とボタン別々）を切り出す。
// 白背景の除去はせず、表示側の CSS clip-path で形に沿って切り抜く前提。
// 実行: node scripts/extract-buzzer-sprites.mjs
// 出力: src/assets/buzzer/*.webp と確認用プレビュー画像
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// WebP 非対応の旧ブラウザ(iOS 12 Safari等)向けに PNG も併備するため、
// ハッシュ付与されない public/ に両形式で出力する
const OUT_DIR = resolve(root, 'public/buzzer')
const OUT_SIZE = 640
const WEBP_QUALITY = 0.85

// 各スプライトの取り出し元: 画像内の連結成分を「行(上/下) → x座標」順に並べた index で指定
// pad: 検出ボックスに対する切り出し枠の倍率 / dx,dy: 中心の微調整（ボックス幅比）
const SPRITES = [
  { file: 'buttons-varied.png', index: 0, name: 'base-round-black', pad: 1.0, dy: -0.02 },
  { file: 'buttons-varied.png', index: 1, name: 'cap-round-red-big', pad: 1.0 },
  { file: 'buttons-varied.png', index: 2, name: 'base-square-silver', pad: 1.0, dy: -0.03 },
  { file: 'buttons-varied.png', index: 3, name: 'cap-square-blue', pad: 1.0 },
  { file: 'buttons-varied.png', index: 4, name: 'base-oct-wood', pad: 1.0, dy: -0.02 },
  { file: 'buttons-varied.png', index: 5, name: 'cap-oct-orange', pad: 1.0 },
  { file: 'buttons-varied.png', index: 6, name: 'base-round-glass', pad: 1.0, dy: -0.01 },
  { file: 'buttons-varied.png', index: 7, name: 'cap-round-green-glow', pad: 1.0 },
  { file: 'buttons-gray-base.png', index: 0, name: 'base-square-gray', pad: 1.0 },
  { file: 'buttons-gray-base.png', index: 1, name: 'cap-round-red', pad: 1.0 },
  { file: 'buttons-gray-base.png', index: 3, name: 'cap-round-blue', pad: 1.0 },
  { file: 'buttons-gray-base.png', index: 5, name: 'cap-round-yellow', pad: 1.0 },
  { file: 'buttons-gray-base.png', index: 7, name: 'cap-round-green', pad: 1.0 },
]

// プレビュー用のスタイル定義（アプリ側 buzzer-styles.js と揃える）
const PREVIEW_STYLES = [
  { label: 'classic', base: 'base-round-black', cap: 'cap-round-red-big', baseClip: 'circle(48.5%)', capClip: 'circle(45%)', capW: 62 },
  { label: 'red', base: 'base-square-gray', cap: 'cap-round-red', baseClip: 'inset(2.5% round 11%)', capClip: 'circle(45%)', capW: 56 },
  { label: 'blue', base: 'base-square-gray', cap: 'cap-round-blue', baseClip: 'inset(2.5% round 11%)', capClip: 'circle(45%)', capW: 56 },
  { label: 'yellow', base: 'base-square-gray', cap: 'cap-round-yellow', baseClip: 'inset(2.5% round 11%)', capClip: 'circle(45%)', capW: 56 },
  { label: 'green', base: 'base-square-gray', cap: 'cap-round-green', baseClip: 'inset(2.5% round 11%)', capClip: 'circle(45%)', capW: 56 },
  { label: 'silver', base: 'base-square-silver', cap: 'cap-square-blue', baseClip: 'inset(4% round 10%)', capClip: 'inset(4% round 16%)', capW: 64 },
  { label: 'wood', base: 'base-oct-wood', cap: 'cap-oct-orange', baseClip: 'polygon(30% 2%, 70% 2%, 98% 30%, 98% 70%, 70% 98%, 30% 98%, 2% 70%, 2% 30%)', capClip: 'polygon(30% 2%, 70% 2%, 98% 30%, 98% 70%, 70% 98%, 30% 98%, 2% 70%, 2% 30%)', capW: 60 },
  { label: 'glass', base: 'base-round-glass', cap: 'cap-round-green-glow', baseClip: 'circle(47%)', capClip: 'circle(45%)', capW: 58 },
]

// file:// は about:blank から読めないため、画像は data URL にして渡す
const asDataUrl = async (path, mime) => `data:${mime};base64,${(await readFile(path)).toString('base64')}`

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--disable-features=NetworkServiceSandbox'],
})

try {
  const page = await browser.newPage()
  await page.goto('about:blank')

  const sourceUrls = {}
  for (const file of [...new Set(SPRITES.map((s) => s.file))]) {
    sourceUrls[file] = await asDataUrl(resolve(root, 'assets-src', file), 'image/png')
  }

  // 画像ごとの連結成分（オブジェクト）検出
  const detect = async (file) => {
    const url = sourceUrls[file]
    return page.evaluate(async (src) => {
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
        if (Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) < 238) mask[i] = 1
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
      const found = boxes
        .filter((b) => b.area > 3000)
        .map((b) => ({
          x: b.minX / scale,
          y: b.minY / scale,
          w: (b.maxX - b.minX + 1) / scale,
          h: (b.maxY - b.minY + 1) / scale,
        }))
      // 行（上/下）→ x 順に並べる
      const midY = img.naturalHeight / 2
      found.sort((a, b) => {
        const rowA = a.y + a.h / 2 > midY ? 1 : 0
        const rowB = b.y + b.h / 2 > midY ? 1 : 0
        return rowA !== rowB ? rowA - rowB : a.x - b.x
      })
      return { count: found.length, boxes: found }
    }, url)
  }

  const detections = {}
  for (const file of [...new Set(SPRITES.map((s) => s.file))]) {
    detections[file] = await detect(file)
    console.log(`${file}: ${detections[file].count} 個のオブジェクトを検出`)
    detections[file].boxes.forEach((b, i) =>
      console.log(`  [${i}] x=${b.x.toFixed(0)} y=${b.y.toFixed(0)} w=${b.w.toFixed(0)} h=${b.h.toFixed(0)}`),
    )
  }

  // 切り出して WebP + PNG の両形式で保存
  await mkdir(OUT_DIR, { recursive: true })
  for (const spec of SPRITES) {
    const box = detections[spec.file].boxes[spec.index]
    if (!box) throw new Error(`${spec.file} に index ${spec.index} のオブジェクトがない`)
    const cx = box.x + box.w / 2 + (spec.dx ?? 0) * box.w
    const cy = box.y + box.h / 2 + (spec.dy ?? 0) * box.h
    const side = Math.max(box.w, box.h) * (spec.pad ?? 1)
    const url = sourceUrls[spec.file]
    const dataUrls = await page.evaluate(
      async ({ src, cx, cy, side, out, q }) => {
        const img = new Image()
        img.src = src
        await img.decode()
        const c = document.createElement('canvas')
        c.width = out
        c.height = out
        const ctx = c.getContext('2d')
        ctx.imageSmoothingQuality = 'high'
        ctx.fillStyle = '#fff'
        ctx.fillRect(0, 0, out, out)
        ctx.drawImage(img, cx - side / 2, cy - side / 2, side, side, 0, 0, out, out)
        // 旧ブラウザ用は JPEG（表示側で clip-path するため透過は不要。PNG は写真的画像で肥大する）
        return { webp: c.toDataURL('image/webp', q), jpg: c.toDataURL('image/jpeg', 0.82) }
      },
      { src: url, cx, cy, side, out: OUT_SIZE, q: WEBP_QUALITY },
    )
    for (const [ext, dataUrl] of Object.entries(dataUrls)) {
      const buf = Buffer.from(dataUrl.split(',')[1], 'base64')
      await writeFile(resolve(OUT_DIR, `${spec.name}.${ext}`), buf)
      console.log(`${spec.name}.${ext} (${(buf.length / 1024).toFixed(0)} KB)`)
    }
  }

  // ダーク背景に台+ボタンを重ねたプレビューを撮る（clip の食い込みや白フチの確認用）
  const spriteUrl = {}
  for (const name of [...new Set(PREVIEW_STYLES.flatMap((s) => [s.base, s.cap]))]) {
    spriteUrl[name] = await asDataUrl(resolve(OUT_DIR, `${name}.webp`), 'image/webp')
  }
  const cells = PREVIEW_STYLES.map((s) => {
    const rig = (down) => `
      <div style="position:relative;width:190px;height:190px;">
        <img src="${spriteUrl[s.base]}"
             style="position:absolute;inset:0;width:100%;height:100%;clip-path:${s.baseClip};">
        <img src="${spriteUrl[s.cap]}"
             style="position:absolute;left:50%;top:50%;width:${s.capW}%;aspect-ratio:1;
                    transform:translate(-50%,-50%) translateY(${down ? '2%' : '-6%'});
                    clip-path:${s.capClip};filter:drop-shadow(0 ${down ? 3 : 10}px ${down ? 4 : 12}px rgba(0,0,0,.55));">
      </div>`
    return `<div style="text-align:center;color:#9aa4b2;font:12px sans-serif;">
      ${rig(false)}${rig(true)}<div>${s.label}</div></div>`
  }).join('')
  await page.setContent(
    `<body style="margin:0;background:#10141a;display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:14px;">${cells}</body>`,
  )
  await page.setViewportSize({ width: 900, height: 1000 })
  await page.waitForTimeout(600)
  const shot = resolve(root, 'assets-src', 'preview.png')
  await page.screenshot({ path: shot, fullPage: true })
  console.log(`プレビュー: ${shot}`)
} finally {
  await browser.close()
}
