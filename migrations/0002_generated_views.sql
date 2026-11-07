-- The product concept changed from "thread-entry drafts" to generated
-- views (Generative UI specs). The drafts table is dropped; generated
-- screens live in generated_views as JSON specs rendered by the client.
CREATE TABLE IF NOT EXISTS generated_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  cluster_key TEXT NOT NULL,
  title TEXT NOT NULL,
  spec TEXT NOT NULL,
  article_count INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,
  warnings TEXT,
  model TEXT,
  origin TEXT NOT NULL DEFAULT 'cron',
  created_at TEXT NOT NULL
);

DROP TABLE IF EXISTS drafts;
