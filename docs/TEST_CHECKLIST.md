# 動作確認チェックリスト

自動テストでカバーできる範囲(Worker・uid/token)と、実機でしか確認できない範囲(Push・通知タップ・TWA)を分けている。

## A. 自動テスト済み(`cd worker && npm test` = 13件)
- [x] フロントが使う全POSTエンドポイント(`/subscribe /reminder /shift-alert-settings /shifts /budget-status /fixed-expenses /calendar-shifts /test`)が Worker に存在
- [x] uid なし/不正(`"anonymous"` 等)は 400、許可外ホストの購読 endpoint は 400
- [x] `/calendar-shifts` → `/calendar.ics?token=`(夜勤は翌日終了、カンマのエスケープ)
- [x] token違い/token無し/token差し替え/他人のtoken乗っ取り は 403
- [x] 利用者Aの設定がBのキーに入らない
- [x] cron: リマインダー・シフト前・予算超過が各1回だけ届き、次のtickで重複しない
- [x] cron: 固定費は当日9時以降に1回(※JST 9時前に実行するとこの1件はスキップされる)
- [x] 購読が 410 で失効したらKVから削除
- [x] `/delete` で全データ削除

## B. uid / token の受け渡し(コードレビュー結果)

| フロント(`public/index.html`) | Worker | 結果 |
|---|---|---|
| `postToPushServer(path, body)` が本文に `{uid, ...}` を自動付与 | 全POSTで `uid`(英数字16〜64)を検証 | ✅ 一致 |
| `/subscribe` `{uid, subscription}` | `data.subscription` を検証して `sub:<uid>` に保存 | ✅ |
| `/reminder` `{uid, enabled, time}` / `/shift-alert-settings` `{uid, enabled, minutesBefore}` | `cfg:<uid>` | ✅ |
| `/shifts` `{uid, shifts}` / `/budget-status` `{uid, month, items}` / `/fixed-expenses` `{uid, items}` | 各 `<種別>:<uid>` | ✅ |
| `/calendar-shifts` `{uid, token, shifts}` | `cal:<uid>` に token と一緒に保存、`calidx:<token>` を作る | ✅ |
| 購読URL `/calendar.ics?token=…` | token から逆引きして配信 | ✅(修正後) |
| `/test` `{uid}` | `sub:<uid>` を引いて送信 | ✅ |
| `/health`(GET) | `{ok,time,vapid}` | ✅ |

### レビューで見つけて修正したズレ・弱点
1. **配信版の `worker/index.js` / `sw.js` が提供ファイルに無かった**(Downloads にあった `index.js` `index.html` `sw.js` `manifest.json` は個人用版で、uidなし・個人用VAPID鍵・個人用token入りだった)。
   個人用ファイルは使わず、配信版の `index_1.html`・`manifest_1.json` を採用し、Worker と Service Worker は配信版の仕様に合わせて新規に書いた。
   → **フロントが送るリクエストの形に合わせて Worker を実装したため、形式のズレは起きない**(自動テストで確認)。
2. 購読URLに `uid` が含まれていた → URLを共有すると uid が漏れ、通知設定の書き換えができた。**token だけのURLに変更**(Worker は token → uid の逆引き)。
3. `localStorage` が使えないとき uid が固定値 `"anonymous"` になり、**複数人のデータが同じキーに混ざる**可能性があった → uid を作れなければ連携を使わせない(`postToPushServer` が例外)。Worker も `"anonymous"` を 400 で拒否。
4. フォールバックのID生成が `Date.now()-Math.random()` で、推測しやすく**ドット入りで Worker の形式に合わない**。→ `crypto.getRandomValues` による32桁16進に統一。
5. Chart.js のCDNがバージョン未固定 → `4.4.7` に固定(オフラインキャッシュとの整合・突然の破壊的更新を避ける)。
6. 個人用の痕跡が残っていた(一括インポート例の勤務先名、`2026-08-07` 固定の基準日、`8月7日時点` ラベル)→ 汎用化。オンボーディングの基準日がUTC日付でズレる問題(日本の0〜9時に前日になる)→ ローカル日付に修正。
7. (未対応・残置)フロントに未使用のAIアドバイス関連コード(`fetchAiAdvice` 等)が残っている。動作に影響なし。

## C. 実機でのチェック(Android 実機・Chrome / TWA)

### C-1. Service Worker の登録・キャッシュ
- [ ] 初回起動後、`chrome://inspect/#service-workers`(または PC の Chrome で `https://<HOST>` → DevTools → Application → Service Workers)で `sw.js` が **activated and is running**
- [ ] Application → Cache Storage に `paycale-v1`(index.html・manifest・アイコン・Chart.js)
- [ ] 機内モードにしてアプリを起動 → 画面が開く、入力・グラフ表示ができる
- [ ] `PUSH_WORKER_URL` 宛の通信がキャッシュされていない(Network で Service Worker 経由の応答になっていない)

### C-2. `push` イベント
- [ ] 設定 → プッシュ通知 → 「通知を有効にする」→ 許可ダイアログ → 「✅ 通知は有効です」
- [ ] Worker 側に購読が入る: `npx wrangler kv key list --binding SUBS --prefix sub:`(本番は `--remote` が必要な場合あり)
- [ ] 「🧪 テスト通知を送る」→ 数秒で「PayCale / テスト通知だよ！」が届く
- [ ] **アプリを完全に閉じた状態**(最近使用したアプリからも消す)で、PCから送って届く:
  ```bash
  curl -X POST https://<WORKER>/test -d '{"uid":"<端末のuid>"}'
  ```
  端末の uid は、PC の Chrome DevTools(リモートデバッグ)で `localStorage.PAYCALE_UID`
- [ ] DevTools → Application → Service Workers → **Push** ボタン(`{"title":"手動","body":"確認"}` を貼る)でも表示される(`event.data.json()` の経路)
- [ ] 本文がJSONでないテキストの Push でも「本文」として表示される(`catch` の経路)
- [ ] 同じ `tag` の通知を2回送ると**1件に置き換わる**(テスト通知を連続で送る=60秒制限があるので間隔を空ける)
- [ ] アイコンが表示される(`icon-192.png`)

### C-3. `notificationclick` イベント
- [ ] アプリが**閉じている**とき、通知タップ → アプリが起動して `index.html` が開く
- [ ] アプリが**開いている(前面/背面)**とき、通知タップ → **新しいウィンドウを作らず**既存のアプリが前面に来る
- [ ] タップした通知が通知シェードから消える(`notification.close()`)
- [ ] TWA 内で開く(URLバーが出ない、ブラウザに飛ばされない)

### C-4. Worker の cron(実時間が必要)
- [ ] リマインダー: 設定時刻を「今の2〜3分後」にして保存 → 時刻から数分以内に届き、**同日に2回目が来ない**
- [ ] シフト前通知: 「30分後」開始のシフトを作り、「30分前に通知」→ すぐ(次の5分tick内)届く。勤務先・時間・見込み給料・応援メッセージが入っている
- [ ] 予算超過: カテゴリ上限を低く設定して支出を記録 → 次のtickで1回だけ届く
- [ ] 固定費: 支払日=今日の固定費を登録 → **9時以降**の最初のtickで届く
- [ ] `npx wrangler tail` にエラーが出ていない
- [ ] アプリをアンインストールして数日後、`sub:<uid>` が自動で消えている(410/404 の掃除)

### C-5. TWA / 配信
- [ ] URLバーが出ない(出る場合は ANDROID_SETUP §4 / §7)
- [ ] Play 経由(内部テスト)でインストールした版でも URLバーが出ない(Play署名鍵の指紋)
- [ ] アイコンが丸/角丸マスクで切れない(maskable)
- [ ] 初回オンボーディング → 勤務先登録 → シフト登録 → 給料見込み・振込日が出る
- [ ] 丸め(15分切り上げ)・最低保証(例: 5時間)を設定した勤務先で、短時間シフトの見込み給料が期待どおり
- [ ] カレンダー同期: 有効化 → 購読URLをGoogleカレンダー(Web)に追加 → シフトが見える(反映は遅れる)
- [ ] 別の端末/別プロファイルで開いても、他人のシフト・設定が見えない(uidが違う)
