import './polyfills.js'
import './style.css'
import { mountPlayer } from './ui/player.js'
import { mountTop } from './ui/top.js'

const app = document.getElementById('app')

// #/join/<CODE> の直リンク（QR経由）なら参加画面へ直行する
const match = location.hash.match(/^#\/join\/([A-Za-z0-9]{4,32})$/)
if (match) {
  mountPlayer(app, { roomCode: match[1].toUpperCase() })
} else {
  mountTop(app)
}
