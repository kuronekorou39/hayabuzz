// スプライト画像の URL 解決。
// WebP 非対応の旧ブラウザ（iOS 12 Safari 等）では JPEG 版に自動で切り替える。
// 画像は public/（buzzer/・mascot/）に両形式で置いてある。

let webpSupported = true

// 1x1 の WebP をデコードできるかで判定する
export const spriteFormatReady = new Promise((resolve) => {
  const probe = new Image()
  probe.onload = () => {
    webpSupported = probe.width === 1
    resolve()
  }
  probe.onerror = () => {
    webpSupported = false
    resolve()
  }
  probe.src = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'
})

const ext = () => (webpSupported ? 'webp' : 'jpg')

export const buzzerSprite = (name) => `./buzzer/${name}.${ext()}`
export const mascotSprite = (name) => `./mascot/${name}.${ext()}`
