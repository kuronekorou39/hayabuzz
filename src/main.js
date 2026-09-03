import './polyfills.js'
import './style.css'
import { loadHostRoom } from './game/room-store.js'
import { applyBackground } from './ui/background.js'
import { mountHost } from './ui/host.js'
import { mountPlayer } from './ui/player.js'
import { mountTop } from './ui/top.js'

const app = document.getElementById('app')
applyBackground()

// #/join/<CODE> の直リンク（QR経由）なら参加画面へ直行する
const joinMatch = location.hash.match(/^#\/join\/([A-Za-z0-9]{4,32})$/)
// #/host/<CODE> は出題者画面の URL。この端末に同じ部屋の保存があれば（リロード等）
// そのまま復帰し、なければ他人の URL を開いただけなのでトップへ
const hostMatch = location.hash.match(/^#\/host\/([A-Za-z0-9]{4,32})$/)
const savedRoom = hostMatch ? loadHostRoom() : null

if (joinMatch) {
  mountPlayer(app, { roomCode: joinMatch[1].toUpperCase() })
} else if (hostMatch && savedRoom !== null && savedRoom.roomCode === hostMatch[1].toUpperCase()) {
  mountHost(app, { saved: savedRoom })
} else {
  if (hostMatch) history.replaceState(null, '', location.pathname + location.search)
  mountTop(app)
}
