# 恩株管理ツール（NISA用）

恩株（売却で元本を回収したあとに残る株）を目指す銘柄の購入検討から恩株化までの進捗、株主優待の有効期限、権利月ごとのウォッチリストを管理する個人用 Web アプリ。
株価・配当・優待の情報は Yahoo!ファイナンス / Google Finance から自動取得する。

**構成: Cloudflare Workers + D1 (SQLite) → 月額 ¥0（無料枠内）**

- 本番 URL: https://zero-cost-stock.zero-cost-stock.workers.dev （パスワードでログイン）
- `main` ブランチに push すると GitHub Actions で自動デプロイされる

---

## 機能

画面は下部ナビ（スマホ）／タブで 3 つのセクションに分かれる。

### 恩株管理

| タブ | 内容 |
|------|------|
| 購入検討 | 目標保有数・恩株数・現在の保有を登録し、追加購入額と「恩株差」（今の株価で恩株化できるか）を表示 |
| 恩株待ち | 目標数まで買い終えた銘柄。売値（恩株化できる株価）・現在売却した場合の金額・売却前後の配当を表示 |
| 恩株化 | 恩株化が完了した銘柄。残った株の評価額・配当予想を表示 |

- 銘柄は **購入検討 → 恩株待ち → 恩株化** とドロワーのボタンで移行できる
- 保有は複数口座（ロット）で登録でき、ロットごとに **NISA / 非NISA** を選べる。非NISA 分は売却益への税（20.315%）を考慮して恩株差を計算する
- 恩株差は緑＝達成可・赤＝未達で色分け

### 優待期限

- 受け取った株主優待（券・ポイントなど）の有効期限と残り日数を一覧表示。期限切れ・7日以内・30日以内で色分けして強調
- 銘柄ごとに前回のメモ・種類をテンプレートとして記憶し、次回登録時に自動入力
- 保有株数に応じた優待内容を Yahoo!ファイナンスの優待ページから取得してメモに入れられる

### ウォッチ

| タブ | 内容 |
|------|------|
| 全て | 登録した全銘柄 |
| 前々月 / 前月 / 当月 | 権利月がそれぞれ「2か月後」「来月」「今月」の銘柄（権利確定の何か月前かで絞り込み） |

- 状態（ウォッチ中 / 保有中 / 最小保有）で絞り込み可能。各タブに件数バッジを表示
- 権利月は配当（🟢）と優待（⚪）の 2 段で表示。Yahoo!ファイナンスから自動取得できる
- 恩株管理の銘柄からウォッチへ登録、ウォッチから購入検討へ登録ができる

### LINE 通知（恩株売値への到達）

- 平日 9:00〜15:30（日本時間）に 30 分ごと、恩株待ちの銘柄の株価を自動で確認する（Cloudflare の Cron Trigger）
- 恩株差がプラス（＝今の株価で売却すれば元本を回収できる）になった銘柄があれば、LINE にまとめて 1 通で通知する
- 通知するのは「未到達 → 到達」に変わったときだけ。株価が恩株売値の前後を行き来しても、同じ銘柄の通知は 1 日 1 回まで
- 恩株差の計算は画面（恩株待ちタブ）と同じ式（非NISA 分の税も考慮）
- 画面上部の「🔔 通知テスト」で LINE にテスト通知を送れる
- 設定方法は下の「LINE 通知の設定」を参照

### 共通

- パスワードによるログイン（30 日間ログイン維持、右上でログアウト）
- PC / スマホ対応。スマホでは行をタップすると詳細ドロワーで全項目を確認・操作できる
- 取得した株価データはブラウザに 30 分キャッシュ。右上の「↻ 更新」で全銘柄を再取得

---

## 計算式

### 購入検討

```
購入数       = 目標保有数 - 現在保有数
現在取得金額 = Σ(ロットの保有数 × 取得平均額)
取得金額     = 現在取得金額 + 購入数 × 終値
売却数       = 目標保有数 - 恩株数
恩株売値     = 取得金額 ÷ 売却数          ← 恩株化できる売値
恩株差       = 終値 - 恩株売値            ← プラスなら今すぐ恩株化可能
購入額       = 購入数 × 終値
配当額       = 目標保有数 × 配当予想（1株）
現在損益     = 終値 × 現在保有数 - 現在取得金額
```

### 恩株待ち

```
売却数   = 保有数 - 恩株数
売値     = 取得金額 ÷ 売却数
現売値   = 売却数 × 終値（非NISA 分は売却益の税を差し引き）
現配当   = 保有数 × 配当予想
後配当   = 恩株数 × 配当予想（恩株化後に残る配当）
```

### 非NISA 分を含む場合の恩株差

非NISA 比率 `f`、非NISA 分の平均取得額 `a`、税率 `T = 0.20315` として、税引き後に元本を回収できる株価を

```
損益分岐株価 = (恩株売値 - f × a × T) ÷ (1 - f × T)
恩株差       = 終値 - 損益分岐株価
```

で求める（全口座から保有比率どおりに売る前提）。

---

## 技術構成

| 層 | 内容 |
|----|------|
| バックエンド | Cloudflare Workers（`src/index.js`）。API・スクレイピング・ログイン認証 |
| DB | Cloudflare D1（SQLite）。テーブル定義は `migrations/` で管理 |
| フロントエンド | 素の HTML / CSS / JavaScript（`public/`）。ビルド不要 |
| デプロイ | GitHub Actions（`.github/workflows/deploy.yml`）で `main` への push 時に D1 マイグレーション適用 → `wrangler deploy` |

### ファイル構成

```
Zero-cost-stock/
├── src/
│   ├── index.js            # Cloudflare Worker（API + スクレイピング + 認証 + 定期実行）
│   └── onkabu-notify.js    # 恩株売値到達の判定と LINE 通知
├── public/
│   ├── index.html          # フロントエンド HTML
│   ├── styles.css          # レスポンシブ CSS
│   └── app.js              # フロントエンド JavaScript
├── migrations/             # D1 テーブル定義（マイグレーション）
├── .github/workflows/
│   └── deploy.yml          # 自動デプロイ
├── wrangler.toml           # Cloudflare Workers 設定
├── package.json
└── README.md
```

### DB テーブル

| テーブル | 用途 |
|----------|------|
| `stocks` | 購入検討 |
| `waiting_stocks` | 恩株待ち |
| `achieved_stocks` | 恩株化 |
| `benefit_expirations` | 優待期限 |
| `benefit_templates` | 優待メモのテンプレート（銘柄ごと） |
| `watchlist` | ウォッチ |
| `onkabu_notify_state` | LINE 通知用：銘柄ごとの前回チェック結果と最終通知日時 |
| `d1_migrations` | 適用済みマイグレーションの記録（wrangler が自動作成） |

### API

すべてログイン必須（未ログイン時は 401）。

| メソッド | パス | 内容 |
|----------|------|------|
| GET / POST | `/api/stocks` | 購入検討の一覧・追加 |
| PUT / DELETE | `/api/stocks/:id` | 購入検討の更新・削除 |
| GET / POST | `/api/waiting-stocks` | 恩株待ちの一覧・追加 |
| PUT / DELETE | `/api/waiting-stocks/:id` | 恩株待ちの更新・削除 |
| GET / POST | `/api/achieved-stocks` | 恩株化の一覧・追加 |
| PUT / DELETE | `/api/achieved-stocks/:id` | 恩株化の更新・削除 |
| GET / POST | `/api/benefits` | 優待期限の一覧・追加 |
| PUT / DELETE | `/api/benefits/:id` | 優待期限の更新・削除 |
| GET | `/api/benefit-templates/:code` | 銘柄の優待メモテンプレート |
| GET / POST | `/api/watchlist` | ウォッチの一覧・追加 |
| PUT / DELETE | `/api/watchlist/:id` | ウォッチの更新・削除 |
| GET | `/api/stock-data/:code` | 終値・会社名・利回り・配当予想を取得 |
| GET | `/api/watch-info/:code` | 優待・配当の権利月を取得 |
| GET | `/api/incentive-info/:code?shares=N` | 保有株数に応じた優待内容を取得 |
| POST | `/api/notify/test` | LINE にテスト通知を送る |
| POST | `/api/notify/run` | 恩株売値の到達チェックを今すぐ実行（到達していれば通知も送る） |

ログイン関連は `/login`（GET: 画面 / POST: ログイン）と `/logout`（POST）。

### データソース

| データ | 取得元 |
|--------|--------|
| 終値・利回り | Yahoo Finance の JSON API（`query1.finance.yahoo.com`）。失敗時は Google Finance |
| 会社名（日本語） | Yahoo!ファイナンス 銘柄ページ（`finance.yahoo.co.jp/quote/{CODE}.T`） |
| 配当予想・配当月 | Yahoo!ファイナンス 配当ページ（`…/{CODE}.T/dividend`） |
| 優待内容・優待月 | Yahoo!ファイナンス 優待ページ（`…/{CODE}.T/incentive`） |

> **注意**: 取得元サイトの HTML 構造が変わると取得に失敗することがある。その場合は `src/index.js` の抽出処理を修正する。

---

## セットアップ・開発

### 前提条件

- [Node.js](https://nodejs.org/) 18 以上
- [Cloudflare アカウント](https://dash.cloudflare.com/sign-up)（無料）

> Windows の PowerShell で `npx` が「スクリプトの実行が無効」エラーになる場合は、`npx.cmd` と打つ（例: `npx.cmd wrangler login`）。

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. Cloudflare にログイン

```bash
npx wrangler login
```

### 3. D1 データベース（新規に環境を作る場合のみ）

既存の本番 DB（`wrangler.toml` の `database_id`）を使う場合は不要。新しく作る場合：

```bash
npm run db:create
```

出力された `database_id` を `wrangler.toml` に設定する。

### 4. マイグレーションの適用

```bash
# 本番環境（Cloudflare）
npm run db:migrate

# ローカル開発環境
npm run db:migrate:local
```

### 5. ログインパスワードの設定

アプリはパスワードでログインしないと使えない（未設定のときは 503 で全アクセスを拒否する）。

```bash
# 本番（Cloudflare の secret に保存。入力を求められるのでパスワードを打つ）
npx wrangler secret put APP_PASSWORD
```

Cloudflare ダッシュボードの「Workers & Pages → zero-cost-stock → 設定 → 変数とシークレット」で、
種類「シークレット」・名前 `APP_PASSWORD` として追加しても同じ。

ローカル開発用は、リポジトリ直下に `.dev.vars`（git 管理外）を作って書く：

```
APP_PASSWORD=ローカル用の任意のパスワード
```

- ログインすると 30 日間 Cookie で維持される。右上の「ログアウト」で解除できる
- パスワードを変更すると、すべての端末のログインが無効になる（データは消えない）
- パスワードを忘れたら、同じコマンドで登録し直せばよい

### LINE 通知の設定

自分専用の LINE 公式アカウント（Messaging API）を作り、そこから自分に通知を送る。無料プランで月 200 通まで。

1. [LINE Developers](https://developers.line.biz/console/) に LINE アカウントでログインし、プロバイダーを作る（名前は任意）
2. 「Messaging API チャネル」を作る（チャネル名は通知の送信者名になる。例: 恩株通知）
3. チャネルの「Messaging API 設定」タブで
   - QR コードを LINE で読み取り、公式アカウントを友だち追加する
   - 一番下の「チャネルアクセストークン（長期）」を「発行」してコピーする
4. 「チャネル基本設定」タブの一番下にある「あなたのユーザー ID」（`U` で始まる文字列）をコピーする
5. 2 つを Cloudflare の secret に登録する（ダッシュボードの「変数とシークレット」でも可）

```bash
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
npx wrangler secret put LINE_USER_ID
```

6. アプリ上部の「🔔 通知テスト」を押して、LINE にテスト通知が届くか確認する

> LINE 公式アカウントの自動応答メッセージが不要なら、LINE Official Account Manager の「応答設定」でオフにする。

### 6. ローカルで動作確認

```bash
npm run dev
```

`http://localhost:8787` でアプリが起動する。

### 7. デプロイ

通常は `main` に push すれば GitHub Actions が自動で「D1 マイグレーション適用 → デプロイ」を行う。
リポジトリの Secrets に `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` が必要で、API トークンには
「Workers Scripts: 編集」と「D1: 編集」の権限が要る。
手動でデプロイする場合：

```bash
npm run deploy
```

---

## テーブルや列を変更するとき（マイグレーション）

1. `npm run db:migration:new -- 変更内容の名前`（例: `add_memo_to_stocks`）で `migrations/000N_….sql` を作る
2. そのファイルに `ALTER TABLE …` などの SQL を書く（**既存のマイグレーションファイルは編集しない**）
3. `npm run db:migrate:local` でローカルに適用して動作確認
4. `main` に push すると、GitHub Actions が **デプロイの前に** 本番 DB へマイグレーションを自動適用する（失敗したらデプロイは行われない）
5. `npm run db:migrations:status` で本番の未適用マイグレーションを確認できる。手動で適用したいときは `npm run db:migrate`

> 自動適用は「DB 更新 → コードのデプロイ」の順なので、列の追加はそのまま 1 回の push で安全に行える。
> 列の削除・名前変更は、まずその列を使わないコードを push し、次の push でマイグレーションを入れる（2 回に分ける）。

### npm スクリプト一覧

| コマンド | 内容 |
|----------|------|
| `npm run dev` | ローカル開発サーバー起動 |
| `npm run deploy` | 本番へ手動デプロイ |
| `npm run db:create` | D1 データベースを新規作成 |
| `npm run db:migration:new -- 名前` | マイグレーションファイルを作成 |
| `npm run db:migrate` | 本番 DB にマイグレーションを適用 |
| `npm run db:migrate:local` | ローカル DB にマイグレーションを適用 |
| `npm run db:migrations:status` | 本番 DB の未適用マイグレーションを表示 |

---

## コスト試算

| リソース | 無料枠 | 想定使用量 |
|----------|--------|-----------|
| Workers リクエスト | 10万回/日 | 個人利用なら 1日数十〜数百回 |
| D1 読み取り | 500万行/日 | 個人利用なら問題なし |
| D1 ストレージ | 5 GB | 銘柄数千件でも数 MB 程度 |
| Workers CPU | 10ms/リクエスト（無料） | 通常の API 操作で収まる |

→ **通常の個人利用では無料枠内で運用可能（月額 ¥0）**

---

## トラブルシューティング

### 「APP_PASSWORD が設定されていません」と表示される

本番の secret が未設定。上記「5. ログインパスワードの設定」の手順で設定する（再デプロイは不要）。

### データが「取得失敗」と表示される

取得元サイトへのアクセスが拒否されているか、サイトの構造が変わった可能性がある。
- 時間をおいて「↻ 更新」ボタンを押す
- 直らない場合は `src/index.js` の抽出処理を修正する

### ローカル開発時に DB エラーが出る

`npm run db:migrate:local` を実行してローカル DB にマイグレーションを適用する。

### デプロイ後に 500 エラーになる

- `wrangler.toml` の `database_id` が正しいか確認する
- 新しい列を使うコードを出したのに本番 DB へのマイグレーションを忘れていないか、`npm run db:migrations:status` で確認する
