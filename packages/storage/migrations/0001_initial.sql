CREATE TABLE accounts (
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

CREATE TABLE style_profiles (
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

CREATE TABLE drafts (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source_type TEXT NOT NULL,
  source_input TEXT NOT NULL,
  generated_text TEXT,
  edited_text TEXT,
  reply_to_json TEXT,
  reply_to_url TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE draft_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  text TEXT NOT NULL,
  score_json TEXT NOT NULL,
  selected INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE post_jobs (
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

CREATE TABLE post_attempts (
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

CREATE INDEX idx_drafts_account_id ON drafts(account_id);
CREATE INDEX idx_jobs_account_status ON post_jobs(account_id, status);
CREATE INDEX idx_attempts_job_id ON post_attempts(job_id);

CREATE TABLE post_history (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  posted_text TEXT NOT NULL,
  post_url TEXT,
  posted_at TEXT NOT NULL
);

CREATE TABLE content_fingerprints (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  text_hash TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  embedding_ref TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_history_account_id ON post_history(account_id);
CREATE INDEX idx_fingerprints_hash ON content_fingerprints(text_hash);
