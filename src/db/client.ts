import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_init",
    sql: `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  name TEXT,
  symbol TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  pair_address TEXT,
  dex_id TEXT,
  quote_asset TEXT
);

CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_id TEXT,
  message_at TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('organic', 'manual_scan')),
  message_text TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (chat_id, message_id, token_address),
  FOREIGN KEY (token_address) REFERENCES tokens(address)
);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  source TEXT NOT NULL,
  pair_address TEXT,
  dex_id TEXT,
  quote_asset TEXT,
  pair_url TEXT,
  raw_payload TEXT,
  metrics_json TEXT NOT NULL,
  score_quality INTEGER NOT NULL,
  score_activity INTEGER NOT NULL,
  score_attention INTEGER NOT NULL,
  score_value INTEGER NOT NULL,
  score_penalties INTEGER NOT NULL,
  score_total INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  provisional INTEGER NOT NULL,
  data_quality TEXT NOT NULL,
  flags_json TEXT NOT NULL,
  config_version TEXT NOT NULL,
  price_usd REAL,
  market_cap_usd REAL,
  liquidity_usd REAL,
  FOREIGN KEY (token_address) REFERENCES tokens(address)
);

CREATE INDEX IF NOT EXISTS idx_scans_token_time ON scans(token_address, scanned_at);
CREATE INDEX IF NOT EXISTS idx_scans_scanned_at ON scans(scanned_at);

CREATE TABLE IF NOT EXISTS watchlist (
  token_address TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  created_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'dismissed')),
  FOREIGN KEY (token_address) REFERENCES tokens(address)
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  author_id TEXT,
  created_at TEXT NOT NULL,
  text TEXT NOT NULL,
  FOREIGN KEY (token_address) REFERENCES tokens(address)
);

CREATE TABLE IF NOT EXISTS followups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  baseline_scan_id INTEGER NOT NULL,
  horizon TEXT NOT NULL CHECK (horizon IN ('15m', '1h', '6h', '24h')),
  scheduled_at TEXT NOT NULL,
  completed_at TEXT,
  price_usd REAL,
  market_cap_usd REAL,
  liquidity_usd REAL,
  score_total INTEGER,
  return_pct REAL,
  UNIQUE (baseline_scan_id, horizon),
  FOREIGN KEY (token_address) REFERENCES tokens(address),
  FOREIGN KEY (baseline_scan_id) REFERENCES scans(id)
);

CREATE INDEX IF NOT EXISTS idx_followups_due
  ON followups(completed_at, scheduled_at);

CREATE TABLE IF NOT EXISTS scan_locks (
  token_address TEXT PRIMARY KEY,
  locked_at TEXT NOT NULL
);
`,
  },
  {
    id: "002_followup_reliability",
    sql: `
ALTER TABLE followups ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'completed', 'unpriced', 'failed'));
ALTER TABLE followups ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE followups ADD COLUMN next_attempt_at TEXT;
ALTER TABLE followups ADD COLUMN last_error TEXT;

UPDATE followups SET status = 'completed' WHERE completed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_followups_retry_due
  ON followups(status, next_attempt_at, scheduled_at);
`,
  },
  {
    id: "003_telegram_transport_only",
    sql: `
DROP TABLE IF EXISTS mentions;
UPDATE watchlist SET created_by = NULL;
UPDATE notes SET author_id = NULL;
`,
  },
  {
    id: "004_scan_sentiment",
    sql: `
ALTER TABLE scans ADD COLUMN sentiment_json TEXT;
ALTER TABLE scans ADD COLUMN sentiment_score INTEGER;
ALTER TABLE scans ADD COLUMN sentiment_verdict TEXT;
ALTER TABLE followups ADD COLUMN sentiment_json TEXT;
ALTER TABLE followups ADD COLUMN sentiment_score INTEGER;
ALTER TABLE followups ADD COLUMN sentiment_verdict TEXT;
`,
  },
];

export function openDatabase(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((r) => (r as { id: string }).id),
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        m.id,
        new Date().toISOString(),
      );
    });
    tx();
  }
}
