// 接続中にリロードやタブ閉じをしようとしたとき、ブラウザ標準の確認ダイアログを出す。
// 画面更新すると部屋から切断されてしまうため、誤操作を確認で防ぐ。
// beforeunload 非対応の環境（旧 iOS Safari 等）では何も出ない（ベストエフォート）。
function onBeforeUnload(ev) {
  ev.preventDefault()
  ev.returnValue = '' // Chrome 系で確認ダイアログを出すために必要
}

let active = false

export function setLeaveGuard(enabled) {
  if (enabled === active) return
  active = enabled
  if (enabled) window.addEventListener('beforeunload', onBeforeUnload)
  else window.removeEventListener('beforeunload', onBeforeUnload)
}
