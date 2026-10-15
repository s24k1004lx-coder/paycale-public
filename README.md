# PayCale 配信版(public)

シフト・給料・家計をまとめて管理する PWA を、Android アプリ(TWA)として配信するための一式。

> ⚠️ **このフォルダは配信(public)専用**。個人で使っている PayCale / Cloudflare Worker / VAPID 鍵とは完全に別物。
> 個人用の値(Worker URL・VAPID鍵・カレンダートークン・勤務先名)は一切含めていない。混ぜないこと。

## フォルダ構成
```
public/            … 静的サイトとして公開するもの(これだけを Pages にデプロイする)
  index.html         アプリ本体
  sw.js              Service Worker(オフライン・Push受信・通知タップ)
  manifest.json      PWA manifest
  icon-*.png         アイコン(any / maskable × 192・512)
  _headers           Cloudflare Pages 用ヘッダ(sw.js等をキャッシュさせない)
  .well-known/assetlinks.json   TWA用(★公開前に値を埋める)
worker/            … 通知・カレンダー配信の Cloudflare Worker
  index.js / wrangler.toml / package.json / test.mjs
android/twa-manifest.json   … Bubblewrap 用テンプレート(値は書き換える)
scripts/check-vapid.mjs     … VAPID 秘密鍵と公開鍵が対応しているか検証
docs/
  requirements.md    要件定義書
  ANDROID_SETUP.md   TWA化〜Google Play 内部テストまで
  TEST_CHECKLIST.md  動作確認チェックリスト(Push/通知タップ/uid・token)
```

## 全体の順番(この順で進める)
**Worker → アプリURL確定 → Pages公開 → Bubblewrap → assetlinks → Play**。
Worker のURLを `index.html` に書いてから公開し、公開URLを元に Bubblewrap を初期化するため、順序を変えると二度手間になる。

---

## 1. Cloudflare Worker を「新規に」デプロイする
前提: Node.js 18+、Cloudflare アカウント。

```bash
cd worker
npm install
npx wrangler login
```

### 1-1. KV ネームスペース SUBS を新規作成してバインド
```bash
npx wrangler kv namespace create SUBS
```
出力される `id = "xxxxxxxx..."` を `worker/wrangler.toml` の
`REPLACE_WITH_KV_NAMESPACE_ID` に貼る(`binding = "SUBS"` はそのまま)。
個人用 Worker の KV とは別のネームスペースになる(`paycale-push-public-SUBS` のような名前が付く)。

### 1-2. `wrangler.toml` の値を確認
| 項目 | 内容 |
|---|---|
| `name` | `paycale-push-public`(個人用と別名。変えるなら URL も変わる) |
| `VAPID_PUBLIC` | `public/index.html` の `PUSH_VAPID_PUBLIC` と**同じ値**(配信版用の鍵) |
| `VAPID_SUBJECT` | `mailto:自分のメール` に書き換える(Push配信側が連絡する宛先。公開リポジトリにメールを載せたくなければ連絡用アドレスを別に用意) |
| `ALLOWED_ORIGIN` | 空のまま(全許可)。Pages 公開後に `https://<公開URL>` へ絞ってよい |

### 1-3. デプロイ
```bash
npx wrangler deploy
```
初回は `workers.dev` のサブドメイン登録を聞かれる。完了すると
`https://paycale-push-public.<あなたのサブドメイン>.workers.dev` が表示される(これが **Worker URL**)。

### 1-4. VAPID 秘密鍵を secret として登録
```bash
npx wrangler secret put VAPID_PRIVATE
```
貼り付ける秘密鍵は、**`PUSH_VAPID_PUBLIC`(`BGIBEt4K…`)とペアのもの**。
先に対応を検証できる:

```bash
# Windows PowerShell:  $env:VAPID_PRIVATE="<秘密鍵>"; node ../scripts/check-vapid.mjs
VAPID_PRIVATE="<秘密鍵>" node ../scripts/check-vapid.mjs
# → "OK: 秘密鍵と公開鍵は対応しています" と出ること
```

**ペアの秘密鍵が手元に無い場合**(配信版を作った時の鍵を紛失した等)は、新しい鍵ペアを作って**両方**差し替える:
```bash
npx web-push generate-vapid-keys
```
1. 出力の Public Key を `worker/wrangler.toml` の `VAPID_PUBLIC` と `public/index.html` の `PUSH_VAPID_PUBLIC` の両方に書く
2. Private Key を `npx wrangler secret put VAPID_PRIVATE` に貼る
3. もう一度 `npx wrangler deploy`
(個人用の鍵は使わない。VAPID を変えると、既存の購読は無効になり再度「通知を有効にする」が必要)

### 1-5. 動作確認
```bash
curl https://paycale-push-public.<サブドメイン>.workers.dev/health
# → {"ok":true,"time":"...","vapid":"BGIBEt4K2aCU"}   ← vapid がフロントの公開鍵の先頭12文字と一致
npx wrangler tail          # 別ターミナルでログを見ながら試すと原因を追いやすい
```
cron(5分おき)は `wrangler.toml` の `[triggers]` で登録済み。ダッシュボードの Worker → Triggers で確認できる。

### 1-6. ローカルテスト(任意)
```bash
npm test      # KVをモックした統合テスト(uid/token/cron/認可)
```

---

## 2. Worker URL を `index.html` に書き込む
`public/index.html` の次の行(プレースホルダ)を、1-3 で表示された URL に置き換える:

```js
const PUSH_WORKER_URL = "https://paycale-push-public.YOUR-SUBDOMAIN.workers.dev";
```
```bash
# リポジトリのルートで(<サブドメイン>を置換。末尾スラッシュ無し)
sed -i 's#paycale-push-public.YOUR-SUBDOMAIN.workers.dev#paycale-push-public.<サブドメイン>.workers.dev#' public/index.html
grep -n "PUSH_WORKER_URL =" public/index.html     # 書き換わったか確認
```
`YOUR-SUBDOMAIN` が残っていると、通知・カレンダー同期が全部失敗する(設定画面の「通知サーバーの状態を確認」で気づける)。

---

## 3. 静的サイトを公開する(Cloudflare Pages 推奨)
```bash
npx wrangler pages deploy public --project-name paycale-public
```
`https://paycale-public.pages.dev` のようなURLが発行される。**TWA は「ドメイン直下」に `/.well-known/assetlinks.json` を置く必要がある**ため、
次の理由で Pages(またはドメイン直下に置けるホスティング)を推奨する。
- ✅ Cloudflare Pages: `*.pages.dev` でも独自ドメインでも、そのドメインの直下に置ける。Worker と同じアカウントで完結
- ⚠️ GitHub Pages: `ユーザー名.github.io/リポジトリ名/` のようなサブパス配信だと、ドメイン直下の `/.well-known/` を置けず TWA の検証に失敗する(`ユーザー名.github.io` というユーザーサイト専用リポジトリなら可)

**ホスト名(例: `paycale-public.pages.dev`)はアプリに焼き込まれ、後から変えられない。長く使うものを選ぶ**
(独自ドメインを使うなら、この時点で Pages に設定する)。

確認: `https://<ホスト>/index.html` が開く / `https://<ホスト>/manifest.json` / `https://<ホスト>/sw.js` が開く。

任意: 公開URLが決まったら `worker/wrangler.toml` の `ALLOWED_ORIGIN = "https://<ホスト>"` にして `npx wrangler deploy`(他サイトからのAPI利用を絞る)。

---

## 4. 以降(Android化・Play公開)
[docs/ANDROID_SETUP.md](docs/ANDROID_SETUP.md) を参照。動作確認は [docs/TEST_CHECKLIST.md](docs/TEST_CHECKLIST.md)。

---

## あなた(人間)が実際にやる作業のまとめ
コードで済む部分は用意済み。以下はアカウント・本人確認・実機が要る作業。

| # | 作業 | いつ | 備考 |
|---|---|---|---|
| 1 | Cloudflare アカウント作成/ログイン(`wrangler login`) | Worker前 | 無料プランで可(利用者が増えたら §requirements 5.4) |
| 2 | KV作成・`wrangler.toml` に id を貼る・`VAPID_SUBJECT` を自分のメールに | Worker | |
| 3 | VAPID 秘密鍵の登録(`wrangler secret put`)。**ペアの鍵が無ければ新規生成して公開鍵を2か所差し替え** | Worker | `scripts/check-vapid.mjs` で検証 |
| 4 | `wrangler deploy` を実行し、Worker URL を `index.html` に書く | Worker後 | |
| 5 | **ドメインを決める**(`*.pages.dev` で可。独自ドメインなら取得・DNS設定) | Pages前 | 後から変更不可 |
| 6 | `wrangler pages deploy public` | 公開 | |
| 7 | JDK 17 / Android SDK の用意(Bubblewrap が初回に案内・自動DLする) | Bubblewrap | |
| 8 | `bubblewrap init` の質問に回答、**署名鍵(keystore)を作ってパスワードと共にバックアップ** | Bubblewrap | 失くすと更新できなくなる場合がある |
| 9 | 署名鍵の SHA-256 を `assetlinks.json` に書いて再デプロイ | assetlinks | Play 署名鍵のSHA-256も後で追加 |
| 10 | **Google Play Console 開発者登録**(本人確認・登録料 US$25 の支払い) | Play | 審査に日数がかかることがある |
| 11 | **プライバシーポリシーのURLを用意**(公開ページに置く) | Play | サーバーへ送るデータは requirements §5.1 |
| 12 | ストア掲載情報・スクリーンショット・データセーフティ・コンテンツレーティングの入力 | Play | |
| 13 | `.aab` をアップロードし、内部テストのテスターを登録 | Play | |
| 14 | Play Console の「アプリの署名」の SHA-256 を `assetlinks.json` に追記して再デプロイ | Play後 | これを忘れるとPlay経由でURLバーが出る |
| 15 | 実機テスト(TEST_CHECKLIST) | 全体 | 通知は実機必須 |
