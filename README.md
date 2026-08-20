# Hayabuzz — サーバレスP2P早押しクイズ

GitHub Pages（静的配信のみ）でホストできる早押しクイズアプリです。バックエンドは持たず、
通信は WebRTC DataChannel による P2P で行います。P2P 層（WebRTC ハンドシェイクと
シグナリング）は外部ライブラリに依存せず自前実装です。

シグナリングには WebTorrent トラッカーの WebSocket プロトコルを使います:
公開トラッカーへ部屋名のハッシュ（info_hash）で announce し、メッセージに相乗りさせた
WebRTC の offer/answer（SDP テキスト）を同じ部屋の相手と交換します。トラッカーを通るのは
この接続情報だけで、接続確立後のゲームデータは端末間の DataChannel を直接流れます
（トラッカーが必要なのは参加の瞬間だけ。ゲーム中に落ちても進行に影響しません）。

## 遊び方

1. 出題者がトップ画面から「出題者として部屋を作る」を選ぶ
2. 募集画面のルームコード / URL / QRコードを回答者に共有し、集まったら「クイズを開始」
   （開始後もヘッダーの「共有」から途中参加者向けに再表示できる）
3. 回答者はニックネームを入力して参加。画面の大半が早押しボタンになる
   （「設定」からボタンの見た目 9 種類と効果音の ON/OFF を変更できる。設定は端末ローカルに保存）
4. 出題者が問題を表示 →「早押し開始」→ 回答者がボタンを押す →
   押下順リスト（1位からのms差つき）を見て正解/不正解を判定 → 得点が更新される
5. 不正解時は「次点へ権利を回す」「全員に再開放（誤答者は除外）」を選べる
6. 出題者の「ルール」から部屋のルールを変更できる:
   - **押下音**: 「回答権を得た人だけ鳴る」（既定）/「押した全員に鳴る」
   - **ハンデ**: プレイヤーごとに押下時刻へ加算する遅延（ms）。順位判定に反映され、
     全員の得点表に表示される

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
│  ├─ transport.js         # 通信層インターフェース（join/leave/send/onMessage/onPeerJoin/onPeerLeave）
│  ├─ webrtc-transport.js  # RTCPeerConnection / DataChannel の自前実装（スター型を強制）
│  ├─ tracker-signal.js    # WebTorrent トラッカープロトコルの自前実装（シグナリング）
│  ├─ protocol.js          # メッセージ型定義とスキーマ検証
│  └─ timesync.js          # RTT / クロックオフセット推定（min-RTTフィルタ + 中央値）
├─ game/
│  ├─ phases.js      # フェーズ定義
│  ├─ buzz.js        # 押下順判定（純関数）
│  └─ host-game.js   # host 権威の状態機械
├─ ui/               # トップ / 出題者 / 回答者 画面（buzzer-styles.js: ボタンの見た目定義）
└─ assets/buzzer/    # 早押しボタンのスプライト（台とボタンで別画像）
```

早押しボタンは「台」と「ボタン」の 2 層で、押下時にボタン部分が沈むアニメーションになる。
効果音は押下・回答権獲得・正解/不正解・ロック通知（host側）を Web Audio で鳴らす。
スプライトは `assets-src/`（git 管理外）の参考画像から
`node scripts/extract-buzzer-sprites.mjs` で再生成できる。

マスコット「クイズ隼人」はトップ画面とファビコンにのみ表示している
（`node scripts/extract-mascot.mjs` で再生成）。

## 開発

```sh
npm install
npm run dev      # 開発サーバ（Trystero のトラッカー接続にインターネットが必要）
npm test         # ユニットテスト（クロックオフセット推定・押下順判定）
npm run test:e2e # E2E テスト（dev サーバは自動起動。初回のみ npx playwright install chromium）
npm run test:all # 上記2つを続けて実行
npm run build    # docs/ に本番ビルドを出力
```

## テスト

- **ユニットテスト**（vitest / `tests/`）: クロックオフセット推定・押下順判定の純関数
- **E2E テスト**（Playwright / `e2e/`）: 実際に Trystero で P2P 接続して検証する
  - 基本フロー: 部屋作成 → 参加 → 出題 → 早押し → 正解 → 得点 → 再接続の得点引き継ぎ → host切断表示
  - **複数端末**: 3人が別ブラウザコンテキスト（=別端末相当。うち1人は iPhone 相当の
    タッチエミュレーション）で同時参加し、ほぼ同時押しの押下順・ms差、
    不正解→次点へ、不正解→全員再開放（誤答者除外）、手動加減点の配信を検証
  - 公開環境に対して実行する場合: `$env:E2E_BASE_URL='https://<user>.github.io/<repo>/'; npm run test:e2e`
  - 本番ビルドに対して実行する場合: `npm run build` → `npm run preview` →
    `$env:E2E_BASE_URL='http://127.0.0.1:4517/'; npm run test:e2e`
- **CI**: GitHub Actions（`.github/workflows/test.yml`）が push / PR ごとに両方を実行する。
  E2E は公開トラッカー経由で実接続するため、稀に不安定な場合はリトライで吸収している。

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
- **一部の回線・端末では P2P 直結を確立できない場合があります**（対称NAT・キャリア回線・
  iCloud プライベートリレー等）。緩和策として複数の STUN と、コミュニティ提供の
  ベストエフォート TURN 中継（Open Relay）をフォールバックに設定しています
  （`src/config.js` の `iceServers`。安定運用したい場合は自前の TURN に差し替え）。
- シグナリングに公開 BitTorrent トラッカーを使うため、トラッカーが全滅していると
  部屋の発見ができません。
- 対応ブラウザの目安は iOS 12 Safari 以降・モダンブラウザ全般です
  （ビルドターゲット safari12 + 最小ポリフィルでレガシー対応）。

## 接続できない端末があるときのチェックリスト

1. 出題者と同じ Wi-Fi に接続する（最も確実）
2. iPhone の場合: 設定 → Wi-Fi → ネットワークの「IPアドレスのトラッキングを制限」をオフ、
   iCloud プライベートリレーを一時的にオフ、VPN をオフ
3. それでも繋がらない場合はモバイル回線⇔Wi-Fi を切り替えて再試行
4. 常に安定させたい場合は自前 TURN サーバを `src/config.js` の `iceServers` に追加

## 接続の設計

- **スター型を WebRTC レベルでも強制**: peer_id の先頭に役割（host/player）を埋め込み、
  回答者はホストの offer にしか answer しない。回答者どうしは接続せず、互いの IP も見えない
- **双方向 offer で参加を即時化**: 参加者側も offer を announce するため、
  ホストの announce 周期を待たずに接続が始まる（典型 2〜5 秒で参加完了）
- 複数トラッカーへ並行 announce（1系統死んでも参加可能）+ 切断時は指数バックオフで再接続
- ICE は vanilla 方式（候補の収集完了を待って SDP に同梱。上限 1.6 秒で打ち切り）
- 同一ペアで両方向に接続が成立した場合は「offer した側の peer_id が小さい方を残す」
  決定的ルールで重複を解決
- クロックオフセット推定は RTT 下位半分のサンプルに絞って中央値を取り（min-RTTフィルタ）、
  混雑回線の非対称誤差を抑える

## 通信層の差し替え

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

別方式（自前シグナリングサーバや PeerJS 等）に切り替える場合は、この契約を満たす実装を
追加して `transport.js` の `createTransport()` を差し替えてください。
ゲームロジック側は通信方式を知りません。

## セキュリティ / プライバシー

- ルームコードは `crypto.getRandomValues` による推測しにくい英数10文字
- 受信メッセージはすべてスキーマ検証してから処理（想定外の型・値は破棄）
- 表示は `textContent` 経由のみ（innerHTML への文字列連結なし）
- ニックネームは表示専用。再接続時の再入力を省くためタブの sessionStorage にのみ保持し、
  タブを閉じれば消えます（localStorage には保存しません）
