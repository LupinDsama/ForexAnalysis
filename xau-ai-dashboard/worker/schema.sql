-- D1 schema for long-term memory (also created lazily by the Worker).
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, -- 'analysis' | 'rule' | 'note'
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TEXT NOT NULL DEFAULT (datetime('now')),
  data TEXT NOT NULL -- compact [[time,open,high,low,close],...]
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS setups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_ts INTEGER NOT NULL,
  trend TEXT NOT NULL,
  style TEXT NOT NULL,
  entry REAL NOT NULL,
  tp REAL NOT NULL,
  sl REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  judged_at TEXT,
  note TEXT
);
