# 恩株管理ツール

Yahoo Finance Japan / Google Finance からデータを取得し、恩株化の目標・進捗を管理する Web アプリ。

**構成: Cloudflare Workers + D1 (SQLite) → 月額 ¥0（無料枠内）**

---

## 機能

| 機能 | 説明 |
|------|------|
| 銘柄登録 | 4桁証券コード・目標保有数・恩株数などを登録 |
| データ自動取得 | 終値・会社名・利回り・配当予想をスクレイピング（30分キャッシュ） |
| 恩株差表示 | 現在の終値と恩株売値の差を色付きで表示（緑=達成可・赤=未達） |
| 損益表示 | 現在保有分の含み損益をリアルタイム計算 |
| PC/スマホ対応 | レスポンシブ表示。スマホでは詳細ドロワーで全項目確認可能 |
| オフライン耐性 | スクレイピングデータは localStorage に 30分キャッシュ |

---

## 計算式

```
購入数       = 目標保有数 - 現在保有数
現在取得金額 = 現在保有数 × 取得平均額
取得金額     = 現在取得金額 + 購入数 × 終値
売却数       = 目標保有数 - 恩株数
恩株売値     = 取得金額 ÷ 売却数          ← 恩株化できる売値
恩株差       = 終値 - 恩株売値            ← プラスなら今すぐ恩株化可能
購入額       = 購入数 × 終値
配当額       = 目標保有数 × 配当予想（1株）
現在損益     = 終値 × 現在保有数 - 現在取得金額
```

---

## セットアップ手順

### 前提条件

- [Node.js](https://nodejs.org/) 18以上
- [Cloudflare アカウント](https://dash.cloudflare.com/sign-up)（無料）

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. Cloudflare にログイン

```bash
npx wrangler login
```

ブラウザが開くので Cloudflare アカウントで認証してください。

### 3. D1 データベースの作成

```bash
npm run db:create
```

実行すると以下のような出力が得られます：

```
✅ Successfully created DB 'zero-cost-stock-db' in region APAC
Created your new D1 database.

[[d1_databases]]
binding = "DB"
database_name = "zero-cost-stock-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   ← これをコピー
```

### 4. wrangler.toml に database_id を設定

`wrangler.toml` の `YOUR_DATABASE_ID_HERE` を上記の ID に置き換えてください：

```toml
[[d1_databases]]
binding = "DB"
database_name = "zero-cost-stock-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  ← ここを変更
```

### 5. データベースの初期化

```bash
# 本番環境（Cloudflare）
npm run db:init

# ローカル開発環境
npm run db:init:local
```

### 6. ローカルで動作確認

```bash
npm run dev
```

`http://localhost:8787` でアプリが起動します。

### 7. 本番デプロイ

```bash
npm run deploy
```

デプロイ後に表示される URL（例: `https://zero-cost-stock.your-subdomain.workers.dev`）がアプリの URL になります。PC・スマホ問わず同じ URL でアクセスできます。

---

## ファイル構成

```
Zero-cost-stock/
├── src/
│   └── index.js          # Cloudflare Worker（API + スクレイピング）
├── public/
│   ├── index.html        # フロントエンド HTML
│   ├── styles.css        # レスポンシブ CSS
│   └── app.js            # フロントエンド JavaScript
├── schema.sql            # D1 テーブル定義
├── wrangler.toml         # Cloudflare Workers 設定
├── package.json
└── README.md
```

---

## データソース

| データ | ソース | URL |
|--------|--------|-----|
| 会社名 | Yahoo Finance Japan | `https://finance.yahoo.co.jp/quote/{CODE}.T` |
| 終値 | Google Finance | `https://www.google.com/finance/quote/{CODE}:TYO` |
| 利回り | Yahoo Finance Japan（配当ページ） | `https://finance.yahoo.co.jp/quote/{CODE}.T/dividend` |
| 配当予想 | Yahoo Finance Japan（配当ページ） | 同上 |

> **注意**: スクレイピング対象サイトの HTML 構造が変更された場合、`src/index.js` の正規表現パターンの修正が必要になることがあります。

---

## コスト試算

| リソース | 無料枠 | 想定使用量 |
|----------|--------|-----------|
| Workers リクエスト | 10万回/日 | 個人利用なら 1日数十回 |
| D1 読み取り | 2500万回/日 | 個人利用なら問題なし |
| D1 ストレージ | 5 GB | 銘柄数千件でも数MB程度 |
| Workers CPU | 10ms/リクエスト（無料） | 通常のAPI操作で収まる |

→ **通常の個人利用では無料枠内で運用可能（月額 ¥0）**

---

## トラブルシューティング

### データが「取得失敗」と表示される

スクレイピング対象サイトへのアクセスが拒否されている可能性があります。
- 時間をおいて「↻（更新）」ボタンをクリック
- Yahoo Finance Japan・Google Finance のサイト構造変更の場合は `src/index.js` を修正

### ローカル開発時に DB エラーが出る

`npm run db:init:local` を実行してローカル DB を初期化してください。

### デプロイ後に 500 エラーになる

`wrangler.toml` の `database_id` が正しく設定されているか確認してください。
