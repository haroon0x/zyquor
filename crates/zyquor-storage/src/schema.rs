//! SQLite schema, copied verbatim from `packages/storage/src/sqlite.ts` so an
//! existing `app.db` opens unchanged.

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY NOT NULL,
  handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  profile_dir TEXT NOT NULL,
  style_profile_id TEXT NOT NULL,
  posting_mode TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  daily_post_limit INTEGER,
  quiet_hours_start TEXT,
  quiet_hours_end TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS style_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  tone TEXT,
  rules_json TEXT NOT NULL,
  banned_phrases_json TEXT NOT NULL,
  example_posts_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_feedback (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS system_feedback_account_idx ON system_feedback(account_id);

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_knowledge_account_enabled ON knowledge_entries(account_id, enabled);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source_type TEXT NOT NULL,
  source_input TEXT NOT NULL,
  generated_text TEXT,
  edited_text TEXT,
  reply_to_json TEXT,
  reply_to_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS draft_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  text TEXT NOT NULL,
  score_json TEXT NOT NULL,
  selected INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  scheduled_for TEXT,
  reply_to_json TEXT,
  reply_to_url TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS post_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES post_jobs(id),
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  screenshot_path TEXT,
  trace_path TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id TEXT PRIMARY KEY NOT NULL,
  config_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  error TEXT,
  packets_created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS post_history (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  posted_text TEXT NOT NULL,
  post_url TEXT,
  source_packet_id TEXT,
  source_type TEXT,
  source_title TEXT,
  source_url TEXT,
  tweet_type TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  posted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS content_fingerprints (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  text_hash TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  embedding_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tweet_measurements (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  tweet_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  posted_at TEXT,
  text TEXT,
  has_link INTEGER,
  source_type TEXT,
  tweet_type TEXT,
  views INTEGER,
  likes INTEGER,
  replies INTEGER,
  reposts INTEGER,
  bookmarks INTEGER,
  measured_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(account_id, tweet_id)
);

CREATE TABLE IF NOT EXISTS source_packets (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  summary TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  tweet_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_drafts_account_id ON drafts(account_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status_created ON drafts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_account_status ON post_jobs(account_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_account_mode_created ON post_jobs(account_id, mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_draft_id ON post_jobs(draft_id);
CREATE INDEX IF NOT EXISTS idx_attempts_job_id ON post_attempts(job_id);
CREATE INDEX IF NOT EXISTS idx_ingest_runs_account_started ON ingest_runs(account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_account_id ON post_history(account_id);
CREATE INDEX IF NOT EXISTS idx_history_draft_id ON post_history(draft_id);
CREATE INDEX IF NOT EXISTS idx_history_posted_at ON post_history(posted_at);
CREATE INDEX IF NOT EXISTS idx_history_account_posted ON post_history(account_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_account_source_packet ON post_history(account_id, source_packet_id);
CREATE INDEX IF NOT EXISTS idx_history_account_source_url ON post_history(account_id, source_url);
CREATE INDEX IF NOT EXISTS idx_fingerprints_hash ON content_fingerprints(text_hash);
CREATE INDEX IF NOT EXISTS idx_fingerprints_account_hash ON content_fingerprints(account_id, text_hash);
CREATE INDEX IF NOT EXISTS idx_source_packets_account_status ON source_packets(account_id, status);
CREATE INDEX IF NOT EXISTS idx_source_packets_created ON source_packets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status_updated ON post_jobs(status, updated_at DESC);
-- Expression indexes for sourcePacketId lookups (json_extract scans without them).
CREATE INDEX IF NOT EXISTS idx_candidates_source_packet ON draft_candidates(json_extract(score_json, '$.sourcePacketId'));
CREATE INDEX IF NOT EXISTS idx_drafts_source_packet ON drafts(json_extract(metadata_json, '$.sourcePacketId'));
CREATE INDEX IF NOT EXISTS idx_tweet_measurements_account_posted ON tweet_measurements(account_id, posted_at DESC);

CREATE TABLE IF NOT EXISTS ingest_configs (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source_type TEXT NOT NULL,
  max_packets_per_day INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  tweet_type_mix_json TEXT NOT NULL,
  schedule_window_start TEXT NOT NULL,
  schedule_window_end TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingest_configs_account_id ON ingest_configs(account_id);
"#;

/// Columns added after the original schema shipped. Applied idempotently, the
/// same way `ensureColumn` does it in TypeScript.
pub const COLUMN_MIGRATIONS: &[(&str, &str, &str)] = &[
    ("drafts", "reply_to_json", "reply_to_json TEXT"),
    ("drafts", "reply_to_url", "reply_to_url TEXT"),
    ("post_jobs", "reply_to_json", "reply_to_json TEXT"),
    ("post_jobs", "reply_to_url", "reply_to_url TEXT"),
    (
        "ingest_configs",
        "metadata_json",
        "metadata_json TEXT NOT NULL DEFAULT '{}'",
    ),
    ("source_packets", "feedback", "feedback TEXT"),
    ("post_history", "source_packet_id", "source_packet_id TEXT"),
    ("post_history", "source_type", "source_type TEXT"),
    ("post_history", "source_title", "source_title TEXT"),
    ("post_history", "source_url", "source_url TEXT"),
    ("post_history", "tweet_type", "tweet_type TEXT"),
    (
        "post_history",
        "metadata_json",
        "metadata_json TEXT NOT NULL DEFAULT '{}'",
    ),
    ("post_history", "text_hash", "text_hash TEXT"),
];
