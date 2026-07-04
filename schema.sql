CREATE TABLE IF NOT EXISTS waiting_stocks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  code                  TEXT    NOT NULL UNIQUE,
  on_kabu_shares        INTEGER NOT NULL DEFAULT 0,
  current_shares        INTEGER NOT NULL DEFAULT 0,
  avg_acquisition_price REAL    NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS achieved_stocks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    NOT NULL UNIQUE,
  current_shares INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stocks (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  code                  TEXT    NOT NULL UNIQUE,
  target_shares         INTEGER NOT NULL DEFAULT 0,
  on_kabu_shares        INTEGER NOT NULL DEFAULT 0,
  current_shares        INTEGER NOT NULL DEFAULT 0,
  avg_acquisition_price REAL    NOT NULL DEFAULT 0,
  created_at            TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS benefit_expirations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code         TEXT    NOT NULL,
  company_name TEXT    NOT NULL DEFAULT '',
  memo         TEXT    NOT NULL DEFAULT '',
  tag          TEXT    NOT NULL DEFAULT '',
  expires_at   TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS benefit_templates (
  code       TEXT NOT NULL PRIMARY KEY,
  memo       TEXT NOT NULL DEFAULT '',
  tag        TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
