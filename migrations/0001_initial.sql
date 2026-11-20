-- 初期スキーマ（2026-11-20 時点の本番 DB の構成をそのまま写したもの）
-- 本番には既にテーブルがあるため IF NOT EXISTS で何も起きず、適用済みとして記録だけされる。
-- 以後のスキーマ変更は 0002_xxx.sql のように新しいファイルを追加して行う（このファイルは編集しない）。

-- 購入検討
CREATE TABLE IF NOT EXISTS stocks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  code                  TEXT    NOT NULL UNIQUE,
  target_shares         INTEGER NOT NULL DEFAULT 0,
  on_kabu_shares        INTEGER NOT NULL DEFAULT 0,
  current_shares        INTEGER NOT NULL DEFAULT 0,
  avg_acquisition_price REAL    NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  lots                  TEXT,
  purchase_nisa         INTEGER NOT NULL DEFAULT 1
);

-- 恩株待ち
CREATE TABLE IF NOT EXISTS waiting_stocks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  code                  TEXT    NOT NULL UNIQUE,
  on_kabu_shares        INTEGER NOT NULL DEFAULT 0,
  current_shares        INTEGER NOT NULL DEFAULT 0,
  avg_acquisition_price REAL    NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  is_nisa               INTEGER NOT NULL DEFAULT 1,
  lots                  TEXT
);

-- 恩株化
CREATE TABLE IF NOT EXISTS achieved_stocks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    NOT NULL UNIQUE,
  current_shares INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  is_nisa        INTEGER NOT NULL DEFAULT 1
);

-- 優待期限
CREATE TABLE IF NOT EXISTS benefit_expirations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL,
  company_name TEXT    NOT NULL DEFAULT '',
  memo         TEXT    NOT NULL DEFAULT '',
  tag          TEXT    NOT NULL DEFAULT '',
  expires_at   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  shares       INTEGER NOT NULL DEFAULT 0
);

-- 優待メモのテンプレート（銘柄ごと）
CREATE TABLE IF NOT EXISTS benefit_templates (
  code       TEXT NOT NULL PRIMARY KEY,
  memo       TEXT NOT NULL DEFAULT '',
  tag        TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ウォッチ
CREATE TABLE IF NOT EXISTS watchlist (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT    NOT NULL,
  company_name    TEXT    NOT NULL DEFAULT '',
  status          TEXT    NOT NULL DEFAULT 'watching',
  shares          INTEGER NOT NULL DEFAULT 0,
  avg_price       REAL,
  benefit_months  TEXT    NOT NULL DEFAULT '[]',
  dividend_yield  REAL,
  memo            TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  dividend_months TEXT    NOT NULL DEFAULT '[]'
);
