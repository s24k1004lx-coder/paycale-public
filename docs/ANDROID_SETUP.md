# PayCale を Android アプリとして配信する(PWA → TWA)

> 先に [README.md](../README.md) の 1〜3(Worker デプロイ → `PUSH_WORKER_URL` 書き換え → Pages 公開)を済ませること。
> このフォルダは配信(public)専用。個人用の Worker・鍵・アプリとは混ぜない。

以降、公開ホストを `<HOST>`(例: `paycale-public.pages.dev`)と書く。

## 0. 前提(コード側は対応済み)
- `public/manifest.json`: 192/512 の `any` と `maskable` アイコン、`start_url`、`scope`、テーマ色
- `public/sw.js`: オフラインキャッシュ + Push受信 + 通知タップ
- Worker は複数ユーザー対応(uid ごとにデータ分離)。AIアドバイスは廃止
- 個人データ・個人専用ルールは除去済み。初回起動時にオンボーディング表示
- 配信版専用の VAPID 公開鍵: `BGIBEt4K2aCUHc_KkFcMLz7DHi2sOz9p3zCL2_OkH17yLwlhZWqvurYl7PgCkvKlb6REjeQGi29A4lQl65t1gAU`
  (秘密鍵は Worker の secret。ペアが無ければ README §1-4 の手順で再生成)

---

## 1. Bubblewrap のインストール
必要なもの: Node.js 18+。JDK 17 と Android SDK は、Bubblewrap が初回に自動ダウンロードを提案する(拒否して自前のパスを指定も可)。

```bash
npm install -g @bubblewrap/cli
bubblewrap doctor        # JDK / Android SDK のパスを確認・設定
```

## 2. プロジェクトの初期化(公開後の manifest.json の URL を指定)
**Android 用の作業フォルダは `android/` を使う**(keystore は `.gitignore` 済み)。

```bash
cd android
bubblewrap init --manifest https://<HOST>/manifest.json
```
manifest から値が読み込まれ、対話で聞かれる。テンプレート [../android/twa-manifest.json](../android/twa-manifest.json) の値に合わせて答える。
`init` が `android/twa-manifest.json` を生成(上書き)するので、テンプレートは**答えの参照用**として使う。

### 2-1. twa-manifest.json 書き換えチェックリスト
| ☐ | キー | 設定値 | 注意 |
|---|---|---|---|
| ☐ | `packageId` | 例 `com.<あなたの名前>.paycale` | **公開後は変更不可・世界で一意**。`com.example.*` のままだと Play に出せない |
| ☐ | `host` | `<HOST>`(`https://` なし・パス無し) | 後から変えられない。assetlinks を置くドメインと同一 |
| ☐ | `fullScopeUrl` | `https://<HOST>/` | `host` と揃える |
| ☐ | `startUrl` | `/index.html` | `manifest.json` の `start_url`(`./index.html`)と同じ場所を指す |
| ☐ | `webManifestUrl` | `https://<HOST>/manifest.json` | `init --manifest` で入る |
| ☐ | `iconUrl` | `https://<HOST>/icon-512.png` | 公開URLで開けること(Playのアイコンにも流用) |
| ☐ | `maskableIconUrl` | `https://<HOST>/icon-512-maskable.png` | 同上 |
| ☐ | `name` / `launcherName` | `PayCale` / `PayCale` | ランチャー表示名は12字以内が目安 |
| ☐ | `themeColor` / `navigationColor` | `#f97316` | `manifest.json` の `theme_color` と一致 |
| ☐ | `backgroundColor` | `#f8fafc` | `manifest.json` の `background_color` と一致 |
| ☐ | `enableNotifications` | `true` | ★これが `false` だと TWA から Web Push 通知が出ない |
| ☐ | `display` / `orientation` | `standalone` / `portrait` | |
| ☐ | `fallbackType` | `customtabs` | assetlinks 検証失敗時の保険(URLバー付きで動く) |
| ☐ | `appVersionName` / `appVersionCode` | `1.0.0` / `1` | **アップロードのたびに `appVersionCode` を +1**(同じ値は拒否される) |
| ☐ | `signingKey.path` / `alias` | `./android.keystore` / `android` | 新規作成時にパスワードを聞かれる |
| ☐ | `isChromeOSOnly` / `isMetaQuest` | `false` / `false` | |

**keystore のバックアップ**: `android.keystore` とそのパスワード・alias を、リポジトリ外(パスワードマネージャ等)に必ず保管する。
Play App Signing を使えばアップロード鍵の紛失は再発行できるが、手間が大きい。

## 3. ビルド
```bash
bubblewrap build
```
生成物(`android/` 内):
- `app-release-bundle.aab` … **Google Play にアップロードする**もの
- `app-release-signed.apk` … 実機に直接インストールして試すもの
- `assetlinks.json` … Digital Asset Links(次章)

## 4. assetlinks.json の生成・配置(重要)
TWA は「アプリ」と「Webサイト」が同じ運営者であることを `https://<HOST>/.well-known/assetlinks.json` で検証する。
無い・指紋が違うと、アプリ内に **URLバーが表示される**(信頼されていない状態)。

### 4-1. 指紋(SHA-256)の取り方
| 指紋 | 取得方法 | 使う場面 |
|---|---|---|
| ローカル keystore(アップロード鍵) | `bubblewrap fingerprint list` または `keytool -list -v -keystore android.keystore -alias android` の SHA256 | `app-release-signed.apk` を実機に直接入れて試すとき |
| **Play の署名鍵** | Play Console → 該当アプリ → **テストとリリース → アプリの署名**(アプリの整合性)の「アプリ署名鍵の証明書」SHA-256 | **Play から入れたアプリ**(内部テスト含む)。★ここが一番忘れやすい |

Play App Signing では、ストアが再署名するため、Play から配信されるアプリの指紋は**手元の keystore とは別物**になる。両方を並べて登録する。

### 4-2. 配置
`public/.well-known/assetlinks.json`(テンプレート済み)を埋める。指紋は複数登録できる:
```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "com.<あなたの名前>.paycale",
      "sha256_cert_fingerprints": [
        "AA:BB:...(ローカルkeystoreの指紋)",
        "CC:DD:...(Play署名鍵の指紋)"
      ]
    }
  }
]
```
`package_name` は `packageId` と完全一致させる。Bubblewrap が出力する `assetlinks.json` の内容を元にしてよい。
```bash
npx wrangler pages deploy public --project-name paycale-public   # 再デプロイ
```

### 4-3. 検証
```bash
curl -i https://<HOST>/.well-known/assetlinks.json     # 200 かつ Content-Type: application/json
```
Google の検証API(`statements` が返ればOK):
```
https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://<HOST>&relation=delegate_permission/common.handle_all_urls
```
端末側: アプリを開いて**アドレスバーが出ない**こと。(キャッシュで古い検証結果が残ることがある。アプリを再インストール or 端末再起動で再検証される)

## 5. 実機テスト
```bash
# USBデバッグを有効にした端末をつないで
bubblewrap install          # app-release-signed.apk をインストール
```
または `app-release-signed.apk` を端末に転送して入れる。確認項目は [TEST_CHECKLIST.md](TEST_CHECKLIST.md)
(URLバーなし・オンボーディング・通知の許可 → テスト通知・機内モード・通知タップ)。
通知は Android 13 以降でランタイム権限が必要。「通知を有効にする」を押したときに許可ダイアログが出る。

## 6. Google Play 内部テストトラックへの登録
### 6-1. 事前に用意するもの
- [ ] Google Play Console の開発者アカウント(登録料 US$25、本人確認)
- [ ] **プライバシーポリシーのURL**(公開ページ。サーバーに送る情報は requirements §5.1 のとおり。端末内データ・Gistトークンは送らない旨も書く)
- [ ] ストア掲載情報: アプリ名、短い説明(80字)、詳しい説明、**512×512 アイコン**(`icon-512.png`)、**フィーチャーグラフィック 1024×500**、**スマホのスクリーンショット(2枚以上)**
- [ ] 「アプリのコンテンツ」の申告: プライバシーポリシー、広告の有無(なし)、アプリのアクセス(ログイン不要)、コンテンツレーティング、ターゲット年齢層、**データセーフティ**(端末識別子相当のランダムID・Push購読・シフト情報をサーバーへ送る旨と、削除方法)
- [ ] 通知を使う場合の説明(任意)

### 6-2. 登録の流れ
1. Play Console で「アプリを作成」(アプリ名・言語・無料)
2. **テストとリリース → 内部テスト → 新しいリリースを作成**
3. Play App Signing に同意し、`app-release-bundle.aab` をアップロード
4. リリース名・リリースノートを入力して保存 → 公開(内部テスト)
5. **テスター**タブでメーリングリスト(Gmail)を作ってテスターに追加(最大100人)
6. 「内部テストに参加するリンク」をテスターに送る → Play ストアからインストール
7. **「アプリの署名」の SHA-256 を `assetlinks.json` に追記して再デプロイ**(§4-1) → URLバーが消えることを確認

### 6-3. 公開(本番)までの残タスク
- 内部テストで §TEST_CHECKLIST を全て通す(特に Play 経由インストールでのURLバー有無・通知)
- **個人の新規開発者アカウントは、本番公開の前にクローズドテスト(目安: 12人以上が14日連続参加)が必要な場合がある。** 条件はPlay Consoleの表示で確認する(ポリシーは変わるため本書では断定しない)
- 段階的公開(例: 5% → 20% → 100%)で様子を見る
- 更新時: Webだけの変更は Pages 再デプロイで反映される(アプリの再審査不要)。`twa-manifest.json` / アイコン / packageId 周りを変えたときだけ `appVersionCode` を上げて再ビルド・再アップロード

## 7. よくあるつまずき
| 症状 | 原因・対処 |
|---|---|
| アプリにURLバーが出る | assetlinks 未配置/`package_name` 違い/**Play署名鍵の指紋が未登録**/`host` 違い。§4-3 で検証 |
| 通知が出ない | `enableNotifications: false`、Android の通知権限OFF、`PUSH_WORKER_URL` がプレースホルダのまま、VAPID 鍵の不一致(`/health` の `vapid` を確認)、省電力による制限。`wrangler tail` を見ながら「テスト通知」 |
| 「通知の登録が失効しています」 | 購読が失効。設定→「通知を有効にする」を押し直す |
| 更新したのに古い画面が出る | Service Worker のキャッシュ。`sw.js` の `CACHE_NAME`(`paycale-v1`)を上げて再デプロイ |
| `bubblewrap build` が失敗 | `bubblewrap doctor` で JDK/SDK を確認。パスワード違い |
| Googleカレンダーの購読が反映されない | 購読の更新間隔は数時間〜1日。URL は設定画面の「URLをコピー」 |
