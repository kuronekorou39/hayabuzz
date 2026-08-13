// I/L/O/0/1 など紛らわしい文字を除いた英数字
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

// crypto.getRandomValues による推測しにくいランダム文字列
export function randomCode(length) {
  const buf = new Uint32Array(length)
  crypto.getRandomValues(buf)
  return Array.from(buf, (n) => CODE_CHARS[n % CODE_CHARS.length]).join('')
}
