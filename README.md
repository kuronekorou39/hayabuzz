# Hayabuzz — サーバレスP2P早押しクイズ

GitHub Pages（静的配信のみ）でホストできる早押しクイズアプリです。バックエンドは持たず、
通信は WebRTC DataChannel による P2P で行います。シグナリングには
[Trystero](https://github.com/dmotz/trystero) の BitTorrent トラッカー戦略
（`@trystero-p2p/torrent`・アカウント不要）を使います。

## 遊び方

1. 出題者がトップ画面から「出題者として部屋を作る」を選ぶ
2. 表示されたルームコード / URL / QRコードを回答者に共有する
3. 回答者はニックネームを入力して参加。画面の大半が早押しボタンになる
4. 出題者が問題を表示 →「早押し開始」→ 回答者がボタンを押す →
   押下順リスト（1位からのms差つき）を見て正解/不正解を判定 → 得点が更新される
5. 不正解時は「次点へ権利を回す」「全員に再開放（誤答者は除外）」を選べる

## アーキテクチャ

- **スター型・host権威**: 出題者（host）が唯一の信頼できる状態
  （参加者・フェーズ・押下順・得点）を保持し、回答者（player）は host から配信された
  状態スナップショットを描画するだけです。player の自己申告値は一切信用しません。
- **押下順判定**: host⇔player 間で ping/pong を往復させて RTT とクロックオフセットを推定
  （複数サンプルの中央値）。player はボタン押下時の `performance.now()` を送信し、
  host がオフセットで host 時計に換算して順位を決めます。**到着順では判定しません**。
  受付開始（host時刻）より前に換算される押下はフライングとして無効です。
- **再接続**: player は sessionStorage のセッションIDで再参加すると得点を引き継ぎます。

```
src/
├─ net/
│  ├─ transport.js   # 通信層インターフェース（join/leave/send/onMessage/onPeerJoin/onPeerLeave）
│  ├─ trystero.js    # Trystero 実装
│  ├─ protocol.js    # メッセージ型定義とスキーマ検証
│  └─ timesync.js    # RTT / クロックオフセット推定
├─ game/
│  ├─ phases.js      # フェーズ定義
│  ├─ buzz.js        # 押下順判定（純関数）
│  └─ host-game.js   # host 権威の状態機械
└─ ui/               # トップ / 出題者 / 回答者 画面
```

## 開発

```sh
npm install
npm run dev    # 開発サーバ（Trystero のトラッカー接続にインターネットが必要）
npm test       # ユニットテスト（クロックオフセット推定・押下順判定）
npm run e2e    # E2E スモークテスト（要: dev サーバ起動中 + Chrome インストール済み）
npm run build  # docs/ に本番ビルドを出力
```

ローカル動作確認は `npm run dev` を起動し、ブラウザで複数タブ
（出題者1 + 回答者N）を開けばできます。`npm run e2e` は Playwright で
「部屋作成 → 参加 → 出題 → 早押し → 判定 → 再接続の得点引き継ぎ → host切断表示」を
自動で通し確認します。

## GitHub Pages へのデプロイ

`vite.config.js` で `base: './'`（相対パス）にしてあるため、
リポジトリ名がどんなサブディレクトリになっても動きます。

### 方法1: main ブランチの /docs を公開（推奨）

1. `npm run build` を実行（`docs/` が生成される）
2. `docs/` をコミットしてプッシュ
3. GitHub のリポジトリ設定 → **Settings → Pages → Build and deployment** で
   Source: `Deploy from a branch`、Branch: `main` / `/docs` を選択
4. `https://<ユーザー名>.github.io/<リポジトリ名>/` で公開される

### 方法2: gh-pages ブランチへデプロイ

```sh
npm run build
git subtree push --prefix docs origin gh-pages
```

Settings → Pages で Branch: `gh-pages` / `/ (root)` を選択します。

## 制限事項

- **host（出題者）が切断すると部屋は終了します。** 状態はすべて host が持っているため、
  host なしでは継続できません（player には「部屋が終了しました」と表示されます）。
  出題者画面の再読み込みも部屋の作り直しになります。
- **対称NAT等の環境では P2P 接続を確立できない場合があります。** TURN サーバを持たないため、
  この場合は接続タイムアウト後に案内を表示します。別回線（モバイル回線など）をお試しください。
- シグナリングに公開 BitTorrent トラッカーを使うため、トラッカーが全滅していると
  部屋の発見ができません。

## 通信層の差し替え（Trystero → PeerJS 等）

通信は `src/net/transport.js` のインターフェースに抽象化してあります:

```js
{
  selfId: string,
  join(roomId): Promise<void>,
  leave(): void,
  send(msg, peerId?): void,   // peerId 省略時はブロードキャスト
  onMessage(cb(msg, peerId)),
  onPeerJoin(cb(peerId)),
  onPeerLeave(cb(peerId)),
}
```

Trystero が不安定な場合は、この契約を満たす実装（例: `src/net/peerjs.js`）を追加し、
`transport.js` の `createTransport()` の分岐に登録してください。
PeerJS の場合は「部屋 = host の Peer ID」として、player 側は roomId から host へ
接続する形にすると同じスター型トポロジになります。

## セキュリティ / プライバシー

- ルームコードは `crypto.getRandomValues` による推測しにくい英数10文字
- 受信メッセージはすべてスキーマ検証してから処理（想定外の型・値は破棄）
- 表示は `textContent` 経由のみ（innerHTML への文字列連結なし）
- ニックネームは表示のみで永続化しません
