// 旧ブラウザ（iOS 12 Safari 等）向けの最小ポリフィル。
// main.js の先頭で最初に import すること（他モジュールの実行前に適用する）。

// Element.replaceChildren: Safari 14+ のため補う
if (!Element.prototype.replaceChildren) {
  const replaceChildren = function (...nodes) {
    this.textContent = ''
    this.append(...nodes)
  }
  Element.prototype.replaceChildren = replaceChildren
  Document.prototype.replaceChildren = replaceChildren
  DocumentFragment.prototype.replaceChildren = replaceChildren
}

// String.replaceAll: Safari 13.1+ のため補う（通信ライブラリが使用）
if (!String.prototype.replaceAll) {
  String.prototype.replaceAll = function (search, replacement) {
    if (typeof search === 'string') {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return this.replace(new RegExp(escaped, 'g'), replacement)
    }
    return this.replace(search, replacement)
  }
}

// Object.hasOwn: Safari 15.4+ のため補う（通信ライブラリが使用）
if (!Object.hasOwn) {
  Object.hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
}

// queueMicrotask / Object.fromEntries: Safari 12.1+ のため補う（iOS 12.0/12.1 向け）
if (!window.queueMicrotask) {
  window.queueMicrotask = (fn) => Promise.resolve().then(fn)
}
if (!Object.fromEntries) {
  Object.fromEntries = (entries) => {
    const obj = {}
    for (const [key, value] of entries) obj[key] = value
    return obj
  }
}

// Array.flat / flatMap: Safari 12.1+ のため補う（iOS 12.0/12.1 向け）
if (!Array.prototype.flat) {
  Array.prototype.flat = function (depth) {
    const d = depth === undefined ? 1 : depth
    if (d <= 0) return this.slice()
    return this.reduce((acc, v) => acc.concat(Array.isArray(v) ? v.flat(d - 1) : v), [])
  }
}
if (!Array.prototype.flatMap) {
  Array.prototype.flatMap = function (fn, thisArg) {
    return this.map(fn, thisArg).flat(1)
  }
}
