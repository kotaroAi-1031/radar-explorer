-- radar-explorer's own database (D1). The radar data itself stays in
-- Turso (read-only from here); this DB holds generated drafts, the
-- diff-detection state per question, and the daily neurons counter.
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT NOT NULL,
  article_count INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  warnings TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  model TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state (
  question_id TEXT PRIMARY KEY,
  last_check_at TEXT,
  frontier TEXT,
  total INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS neurons (
  day TEXT PRIMARY KEY,
  neurons REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0
);
