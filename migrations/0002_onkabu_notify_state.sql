-- 恩株化ライン到達の LINE 通知用：銘柄ごとの前回チェック結果
-- ready が 0 → 1 に変わったときだけ通知し、同じ銘柄の通知は 1 日 1 回までにする
CREATE TABLE IF NOT EXISTS onkabu_notify_state (
  code        TEXT    NOT NULL PRIMARY KEY,
  ready       INTEGER NOT NULL DEFAULT 0,      -- 前回チェック時に恩株差 >= 0 だったか
  last_price  REAL,                            -- 前回チェック時の株価
  last_diff   REAL,                            -- 前回チェック時の恩株差
  notified_at TEXT,                            -- 最後に通知した日時（ISO 8601）
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
