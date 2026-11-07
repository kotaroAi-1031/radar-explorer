-- Chat threads (sessions). One thread = one ExplorerAgent Durable Object
-- instance (the DO name is the thread id); this table is only the index
-- the sidebar renders: id, display title and timestamps. The legacy
-- single conversation used the DO name "main"; the API seeds a row for
-- it so that history stays reachable from the thread list.
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
