// assets-src/ の参考画像から早押しボタンのスプライト（台とボタン別々）を切り出す。
// 白背景の除去はせず、表示側の CSS clip-path で形に沿って切り抜く前提。
// 実行: node scripts/extract-buzzer-sprites.mjs
// 出力: public/buzzer/*.webp + *.jpg と確認用プレビュー画像
//
// 切り出しは「形状（円・角丸四角・八角形）の中心」を画素解析で求めて行う。
// 元画像の焼き込み影を含む bbox の中心だと形状が出力内でずれ、clip-path や
// 台とボタンの重ね合わせと食い違うため、影を除いた形状基準で正規化する:
//   - cap(色付きボタン): 彩度（max-min チャンネル差）マスクの bbox 中心
//   - base(台): エッジ閾値で各行の左右端を取り、上部60%行（影は下に出る）の
//     最大スパンを直径 D とし、cx はその行群の中央値、cy は頂点 + D/2（正方形/円前提）
// どのスプライトも形状が出力の FILL (94%) を占めるので、clip は固定値で計算できる。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { chromium } from 'playwright'
import { BUZZER_STYLES } from '../src/ui/buzzer-styles.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// WebP 非対応の旧ブラウザ(iOS 12 Safari等)向けに JPEG も併備するため、
// ハッシュ付与されない public/ に両形式で出力する
const OUT_DIR = resolve(root, 'public/buzzer')
const OUT_SIZE = 640
const WEBP_QUALITY = 0.85
const FILL = 0.94 // 形状の直径/辺が出力サイズに占める割合（buzzer-styles.js の clip 値と対応）

// 各スプライトの取り出し元: 画像内の連結成分を「行(上/下) → x座標」順に並べた index で指定
// detect: 形状検出方法 / chromaT: 彩度閾値 / edgeT: 「これより暗ければ本体」の輝度閾値
const SPRITES = [
  { file: 'buttons-varied.png', index: 0, name: 'base-round-black', detect: 'edge', edgeT: 150 },
  { file: 'buttons-varied.png', index: 1, name: 'cap-round-red-big', detect: 'chroma', chromaT: 45 },
  { file: 'buttons-varied.png', index: 2, name: 'base-square-silver', detect: 'edge', edgeT: 215 },
  { file: 'buttons-varied.png', index: 3, name: 'cap-square-blue', detect: 'chroma', chromaT: 40 },
  { file: 'buttons-varied.png', index: 4, name: 'base-oct-wood', detect: 'edge', edgeT: 200 },
  { file: 'buttons-varied.png', index: 5, name: 'cap-oct-orange', detect: 'chroma', chromaT: 40 },
  { file: 'buttons-varied.png', index: 6, name: 'base-round-glass', detect: 'edge', edgeT: 228 },
  { file: 'buttons-varied.png', index: 7, name: 'cap-round-green-glow', detect: 'chroma', chromaT: 22 },
  { file: 'buttons-gray-base.png', index: 0, name: 'base-square-gray', detect: 'edge', edgeT: 215 },
  { file: 'buttons-gray-base.png', index: 1, name: 'cap-round-red', detect: 'chroma', chromaT: 45 },
  { file: 'buttons-gray-base.png', index: 3, name: 'cap-round-blue', detect: 'chroma', chromaT: 45 },
  { file: 'buttons-gray-base.png', index: 5, name: 'cap-round-yellow', detect: 'chroma', chromaT: 45 },
  { file: 'buttons-gray-base.png', index: 7, name: 'cap-round-green', detect: 'chroma', chromaT: 45 },
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
  }

  // 形状中心を検出して切り出し、WebP + JPEG の両形式で保存
  await mkdir(OUT_DIR, { recursive: true })
  for (const spec of SPRITES) {
    const box = detections[spec.file].boxes[spec.index]
    if (!box) throw new Error(`${spec.file} に index ${spec.index} のオブジェクトがない`)
    const result = await page.evaluate(
      async ({ src, box, spec, out, q, fill }) => {
        const img = new Image()
        img.src = src
        await img.decode()
        // 連結成分 bbox の少し外側を解析領域にする
        const margin = Math.max(box.w, box.h) * 0.05
        const rx = Math.max(0, Math.round(box.x - margin))
        const ry = Math.max(0, Math.round(box.y - margin))
        const rw = Math.min(img.naturalWidth - rx, Math.round(box.w + margin * 2))
        const rh = Math.min(img.naturalHeight - ry, Math.round(box.h + margin * 2))
        const c = document.createElement('canvas')
        c.width = rw
        c.height = rh
        const ctx = c.getContext('2d', { willReadFrequently: true })
        ctx.drawImage(img, rx, ry, rw, rh, 0, 0, rw, rh)
        const d = ctx.getImageData(0, 0, rw, rh).data
        const solid = (x, y) => {
          const i = (y * rw + x) * 4
          const r = d[i], g = d[i + 1], b = d[i + 2]
          if (spec.detect === 'chroma') return Math.max(r, g, b) - Math.min(r, g, b) > spec.chromaT
          return Math.min(r, g, b) < spec.edgeT
        }

        let cx, cy, half
        if (spec.detect === 'chroma') {
          // 彩度マスクの bbox（無彩色の影は含まれない）
          let minX = rw, maxX = 0, minY = rh, maxY = 0
          for (let y = 0; y < rh; y++) {
            for (let x = 0; x < rw; x++) {
              if (!solid(x, y)) continue
              if (x < minX) minX = x
              if (x > maxX) maxX = x
              if (y < minY) minY = y
              if (y > maxY) maxY = y
            }
          }
          cx = (minX + maxX) / 2
          cy = (minY + maxY) / 2
          half = Math.max(maxX - minX, maxY - minY) / 2
        } else {
          // 各行の左右エッジ。影は下方に出るため上部60%の行だけで直径を推定する
          const spans = []
          for (let y = 0; y < Math.round(rh * 0.6); y++) {
            let l = -1, r = -1
            for (let x = 0; x < rw; x++) if (solid(x, y)) { l = x; break }
            for (let x = rw - 1; x >= 0; x--) if (solid(x, y)) { r = x; break }
            if (l >= 0 && r > l) spans.push({ y, l, r, span: r - l + 1 })
          }
          const dMax = Math.max(...spans.map((s) => s.span))
          const wide = spans.filter((s) => s.span >= dMax * 0.985)
          cx = wide.reduce((a, s) => a + (s.l + s.r) / 2, 0) / wide.length
          // 頂点: cx 列を上から走査
          let topY = 0
          const ix = Math.round(cx)
          for (let y = 0; y < rh; y++) if (solid(ix, y)) { topY = y; break }
          half = dMax / 2
          cy = topY + half // 正方形/円/正八角形（高さ=幅）前提
        }

        const side = (half * 2) / fill
        const oc = document.createElement('canvas')
        oc.width = out
        oc.height = out
        const octx = oc.getContext('2d')
        octx.imageSmoothingQuality = 'high'
        octx.fillStyle = '#fff'
        octx.fillRect(0, 0, out, out)
        octx.drawImage(img, rx + cx - side / 2, ry + cy - side / 2, side, side, 0, 0, out, out)
        // 旧ブラウザ用は JPEG（表示側で clip-path するため透過は不要。PNG は写真的画像で肥大する）
        return {
          webp: oc.toDataURL('image/webp', q),
          jpg: oc.toDataURL('image/jpeg', 0.82),
          shape: { cx: rx + cx, cy: ry + cy, half },
        }
      },
      { src: sourceUrls[spec.file], box, spec, out: OUT_SIZE, q: WEBP_QUALITY, fill: FILL },
    )
    console.log(
      `${spec.name}: 形状中心 (${result.shape.cx.toFixed(0)}, ${result.shape.cy.toFixed(0)}) 半径 ${result.shape.half.toFixed(0)}`,
    )
    for (const ext of ['webp', 'jpg']) {
      const buf = Buffer.from(result[ext].split(',')[1], 'base64')
      await writeFile(resolve(OUT_DIR, `${spec.name}.${ext}`), buf)
      console.log(`  ${spec.name}.${ext} (${(buf.length / 1024).toFixed(0)} KB)`)
    }
  }

  // ダーク背景に台+ボタンを重ねたプレビューを撮る（clip の食い込みや白フチの確認用）。
  // スタイル定義はアプリ本体の buzzer-styles.js をそのまま使う
  const styles = BUZZER_STYLES.filter((s) => s.base !== undefined)
  const spriteUrl = {}
  for (const name of [...new Set(styles.flatMap((s) => [s.base, s.cap]))]) {
    spriteUrl[name] = await asDataUrl(resolve(OUT_DIR, `${name}.webp`), 'image/webp')
  }
  const cells = styles.map((s) => {
    const rig = (down) => `
      <div style="position:relative;width:190px;height:190px;">
        <img src="${spriteUrl[s.base]}"
             style="position:absolute;inset:0;width:100%;height:100%;clip-path:${s.baseClip};">
        <img src="${spriteUrl[s.cap]}"
             style="position:absolute;left:50%;top:50%;width:${s.capW};aspect-ratio:1;
                    transform:translate(calc(-50% + ${s.capDx ?? '0%'}), calc(-50% + ${s.capDy ?? '0%'})) translateY(${down ? '2.5%' : '-6%'});
                    clip-path:${s.capClip};filter:drop-shadow(0 ${down ? 3 : 10}px ${down ? 4 : 12}px rgba(0,0,0,.55));">
      </div>`
    return `<div style="text-align:center;color:#9aa4b2;font:12px sans-serif;">
      ${rig(false)}${rig(true)}<div>${s.id}</div></div>`
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
