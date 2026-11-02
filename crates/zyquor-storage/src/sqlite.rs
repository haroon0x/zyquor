//! SQLite repository, ported from `packages/storage/src/sqlite.ts`.
//!
//! This covers the accounts, drafts, jobs, attempts and post-history surface.
//! Source packets, knowledge entries, ingest configs/runs, tweet measurements,
//! style profiles and system feedback are not ported yet (see
//! `docs/rust-migration.md`).

use std::path::Path;
use std::str::FromStr;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value};
use zyquor_core::ReplyTarget;
use zyquor_core::spacing::{NextAutopostInput, next_autopost_scheduled_for};
use zyquor_core::types::{DraftStatus, PostJobStatus, PostingMode};
use zyquor_core::{can_transition_draft, parse_reply_target_url};

use crate::model::{
    ApproveDraft, Draft, DraftCandidate, DraftWithCandidates, IngestConfig, IngestConfigUpdate,
    IngestRun, IngestRunStatus, IngestRunUpdate, KnowledgeEntry, KnowledgeUpdate, NewAttempt,
    NewDraft, NewIngestConfig, NewKnowledgeEntry, NewPostHistory, NewSourcePacket,
    NewTweetMeasurement, PostAttempt, PostHistory, PostJob, SourcePacket, SourcePacketStatus,
    StyleProfile, StyleProfileUpdate, SystemFeedback, TweetMeasurement,
};
use crate::schema::{COLUMN_MIGRATIONS, POST_MIGRATION_SQL, SCHEMA};
use crate::utils::{hash_post_text, new_id, normalize_post_text};

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
    #[error("not found: {0}")]
    NotFound(String),
}

type Result<T> = std::result::Result<T, StorageError>;

pub struct SqliteRepository {
    conn: Connection,
    now: Box<dyn Fn() -> String + Send + Sync>,
}

fn default_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl SqliteRepository {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        Self::init(conn, true)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?, false)
    }

    pub fn open_with_now(
        path: impl AsRef<Path>,
        now: impl Fn() -> String + Send + Sync + 'static,
    ) -> Result<Self> {
        let mut repo = Self::open(path)?;
        repo.now = Box::new(now);
        Ok(repo)
    }

    /// In-memory database with a fixed clock, for deterministic tests.
    pub fn open_in_memory_with_now(
        now: impl Fn() -> String + Send + Sync + 'static,
    ) -> Result<Self> {
        let mut repo = Self::open_in_memory()?;
        repo.now = Box::new(now);
        Ok(repo)
    }

    fn init(conn: Connection, on_disk: bool) -> Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON")?;
        if on_disk {
            // WAL lets API reads proceed while another write is in-flight, and
            // NORMAL sync avoids fsync-per-commit on a local-first database.
            conn.execute_batch(
                "PRAGMA journal_mode = WAL;\n\
                 PRAGMA synchronous = NORMAL;\n\
                 PRAGMA busy_timeout = 5000;",
            )?;
        }
        conn.execute_batch(SCHEMA)?;
        for (table, column, definition) in COLUMN_MIGRATIONS {
            ensure_column(&conn, table, column, definition)?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_history_account_no_hash \
             ON post_history(account_id) WHERE text_hash IS NULL",
        )?;
        conn.execute_batch(POST_MIGRATION_SQL)?;
        // The five legacy tweet types were retired (see `TWEET_TYPES`). Fold
        // surviving rows into the current set so validation keeps working.
        for table in ["post_history", "source_packets", "tweet_measurements"] {
            conn.execute_batch(&format!(
                "UPDATE {table} SET tweet_type = CASE tweet_type \
                   WHEN 'news_context' THEN 'useful_info' \
                   WHEN 'lesson' THEN 'guide' \
                   WHEN 'tool' THEN 'useful_info' \
                   WHEN 'hiring' THEN 'useful_info' \
                   WHEN 'article_summary' THEN 'useful_info' \
                 END \
                 WHERE tweet_type IN ('news_context', 'lesson', 'tool', 'hiring', 'article_summary')"
            ))?;
        }

        let repo = Self {
            conn,
            now: Box::new(default_now),
        };
        repo.seed_defaults()?;
        Ok(repo)
    }

    /// Matches `createSqliteRepository`: on an empty database, insert the
    /// default style profile and the `account_personal` account.
    fn seed_defaults(&self) -> Result<()> {
        let style_count: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM style_profiles", [], |row| row.get(0))?;
        if style_count == 0 {
            let timestamp = self.now();
            self.conn.execute(
                "INSERT INTO style_profiles (
                   id, name, description, tone, rules_json, banned_phrases_json,
                   example_posts_json, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    "style_default",
                    "Default",
                    "Default concise posting style.",
                    "clear, concrete, low-filler",
                    "{}",
                    json_strings(&[
                        "game changer".to_string(),
                        "unlock".to_string(),
                        "10x".to_string(),
                    ]),
                    "[]",
                    timestamp,
                    timestamp,
                ],
            )?;
        }

        let account_count: i64 =
            self.conn
                .query_row("SELECT COUNT(*) FROM accounts", [], |row| row.get(0))?;
        if account_count == 0 {
            let timestamp = self.now();
            self.conn.execute(
                "INSERT INTO accounts (
                   id, handle, display_name, profile_dir, style_profile_id, posting_mode,
                   enabled, daily_post_limit, quiet_hours_start, quiet_hours_end,
                   created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    "account_personal",
                    "personal-main",
                    "Personal main",
                    "profiles/personal-main",
                    "style_default",
                    "prepare_only",
                    1_i64,
                    300_i64,
                    Option::<String>::None,
                    Option::<String>::None,
                    timestamp,
                    timestamp,
                ],
            )?;
        }
        Ok(())
    }

    fn now(&self) -> String {
        (self.now)()
    }

    fn transaction<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        match f() {
            Ok(value) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    // --- accounts ------------------------------------------------------

    pub fn list_accounts(&self) -> Result<Vec<zyquor_accounts::Account>> {
        let mut statement = self
            .conn
            .prepare("SELECT * FROM accounts ORDER BY created_at ASC")?;
        let rows = statement.query_map([], account_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_account(&self, id: &str) -> Result<Option<zyquor_accounts::Account>> {
        Ok(self
            .conn
            .query_row(
                "SELECT * FROM accounts WHERE id = ?",
                [id],
                account_from_row,
            )
            .optional()?)
    }

    pub fn create_account(
        &self,
        handle: &str,
        display_name: &str,
        profile_dir: &str,
        style_profile_id: &str,
    ) -> Result<zyquor_accounts::Account> {
        self.transaction(|| {
            let duplicate: Option<String> = self
                .conn
                .query_row(
                    "SELECT id FROM accounts WHERE handle = ?",
                    [handle],
                    |row| row.get(0),
                )
                .optional()?;
            if duplicate.is_some() {
                return Err(StorageError::Invalid(format!(
                    "Duplicate account handle: {handle}"
                )));
            }

            let timestamp = self.now();
            let account = zyquor_accounts::Account {
                id: new_id("account"),
                handle: handle.to_string(),
                display_name: display_name.to_string(),
                profile_dir: profile_dir.to_string(),
                style_profile_id: style_profile_id.to_string(),
                posting_mode: PostingMode::DraftOnly,
                enabled: true,
                daily_post_limit: Some(5),
                quiet_hours_start: None,
                quiet_hours_end: None,
                created_at: timestamp.clone(),
                updated_at: timestamp,
            };

            self.conn.execute(
                "INSERT INTO accounts (
                   id, handle, display_name, profile_dir, style_profile_id, posting_mode,
                   enabled, daily_post_limit, quiet_hours_start, quiet_hours_end, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    account.id,
                    account.handle,
                    account.display_name,
                    account.profile_dir,
                    account.style_profile_id,
                    account.posting_mode.as_str(),
                    i64::from(account.enabled),
                    account.daily_post_limit,
                    account.quiet_hours_start,
                    account.quiet_hours_end,
                    account.created_at,
                    account.updated_at,
                ],
            )?;
            Ok(account)
        })
    }

    pub fn update_account(
        &self,
        id: &str,
        update: &crate::model::AccountUpdate,
    ) -> Result<zyquor_accounts::Account> {
        self.transaction(|| {
            let mut account = self
                .get_account(id)?
                .ok_or_else(|| StorageError::NotFound(id.to_string()))?;

            if let Some(value) = &update.display_name {
                account.display_name = value.clone();
            }
            if let Some(value) = &update.profile_dir {
                account.profile_dir = value.clone();
            }
            if let Some(value) = update.posting_mode {
                account.posting_mode = value;
            }
            if let Some(value) = update.enabled {
                account.enabled = value;
            }
            if let Some(value) = &update.daily_post_limit {
                account.daily_post_limit = *value;
            }
            if let Some(value) = &update.quiet_hours_start {
                account.quiet_hours_start = value.clone();
            }
            if let Some(value) = &update.quiet_hours_end {
                account.quiet_hours_end = value.clone();
            }
            account.updated_at = self.now();

            self.conn.execute(
                "UPDATE accounts
                 SET display_name = ?, profile_dir = ?, posting_mode = ?, enabled = ?,
                     daily_post_limit = ?, quiet_hours_start = ?, quiet_hours_end = ?, updated_at = ?
                 WHERE id = ?",
                params![
                    account.display_name,
                    account.profile_dir,
                    account.posting_mode.as_str(),
                    i64::from(account.enabled),
                    account.daily_post_limit,
                    account.quiet_hours_start,
                    account.quiet_hours_end,
                    account.updated_at,
                    account.id,
                ],
            )?;
            Ok(account)
        })
    }

    pub fn delete_account(&self, id: &str) -> Result<zyquor_accounts::Account> {
        self.transaction(|| {
            let account = self
                .get_account(id)?
                .ok_or_else(|| StorageError::NotFound(id.to_string()))?;

            let blocked: Option<String> = self
                .conn
                .query_row(
                    "SELECT id FROM post_jobs
                     WHERE account_id = ?
                       AND status NOT IN ('posted', 'cancelled')
                     LIMIT 1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(job) = blocked {
                return Err(StorageError::Invalid(format!(
                    "Cannot delete account with non-terminal job: {job}"
                )));
            }

            let run = |sql: &str| self.conn.execute(sql, [id]).map(|_| ());
            run("DELETE FROM post_attempts WHERE job_id IN (SELECT id FROM post_jobs WHERE account_id = ?)")?;
            run("DELETE FROM post_history WHERE account_id = ?")?;
            run("DELETE FROM tweet_measurements WHERE account_id = ?")?;
            run("DELETE FROM post_jobs WHERE account_id = ?")?;
            run("DELETE FROM draft_candidates WHERE draft_id IN (SELECT id FROM drafts WHERE account_id = ?)")?;
            run("DELETE FROM drafts WHERE account_id = ?")?;
            run("DELETE FROM source_packets WHERE account_id = ?")?;
            run("DELETE FROM ingest_runs WHERE account_id = ?")?;
            run("DELETE FROM ingest_configs WHERE account_id = ?")?;
            run("DELETE FROM system_feedback WHERE account_id = ?")?;
            run("DELETE FROM knowledge_entries WHERE account_id = ?")?;
            run("DELETE FROM accounts WHERE id = ?")?;

            Ok(account)
        })
    }

    // --- drafts --------------------------------------------------------

    pub fn create_draft(&self, input: &NewDraft) -> Result<DraftWithCandidates> {
        self.transaction(|| {
            let account_exists: Option<String> = self
                .conn
                .query_row(
                    "SELECT id FROM accounts WHERE id = ?",
                    [&input.account_id],
                    |row| row.get(0),
                )
                .optional()?;
            if account_exists.is_none() {
                return Err(StorageError::Invalid(format!(
                    "Account not found: {}",
                    input.account_id
                )));
            }

            let timestamp = self.now();
            let first_text = input.candidates.first().map(|candidate| candidate.text.clone());
            let reply_to = input.reply_to.clone().or_else(|| {
                input
                    .reply_to_url
                    .as_deref()
                    .and_then(parse_reply_target_url)
            });

            let draft = Draft {
                id: new_id("draft"),
                account_id: input.account_id.clone(),
                source_type: "text".to_string(),
                source_input: input.source_input.clone(),
                generated_text: first_text.clone(),
                edited_text: first_text.clone(),
                reply_to,
                reply_to_url: input.reply_to_url.clone(),
                metadata: input.metadata.clone(),
                status: if first_text.is_some() {
                    DraftStatus::Selected
                } else {
                    DraftStatus::Created
                },
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            };

            self.conn.execute(
                "INSERT INTO drafts (
                   id, account_id, source_type, source_input, generated_text, edited_text,
                   reply_to_json, reply_to_url, metadata_json, status, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    draft.id,
                    draft.account_id,
                    draft.source_type,
                    draft.source_input,
                    draft.generated_text,
                    draft.edited_text,
                    serialize_reply_target(draft.reply_to.as_ref())?,
                    draft.reply_to_url,
                    Value::Object(draft.metadata.clone()).to_string(),
                    draft.status.as_str(),
                    draft.created_at,
                    draft.updated_at,
                ],
            )?;

            let mut candidates = Vec::with_capacity(input.candidates.len());
            for (index, candidate) in input.candidates.iter().enumerate() {
                let mut score = candidate.score.clone();
                score.insert("index".to_string(), Value::from(index));
                let row = DraftCandidate {
                    id: new_id("candidate"),
                    draft_id: draft.id.clone(),
                    text: candidate.text.clone(),
                    score,
                    selected: index == 0,
                    created_at: timestamp.clone(),
                };
                self.conn.execute(
                    "INSERT INTO draft_candidates (id, draft_id, text, score_json, selected, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)",
                    params![
                        row.id,
                        row.draft_id,
                        row.text,
                        Value::Object(row.score.clone()).to_string(),
                        i64::from(row.selected),
                        row.created_at,
                    ],
                )?;
                candidates.push(row);
            }

            Ok(DraftWithCandidates { draft, candidates })
        })
    }

    pub fn get_draft(&self, id: &str) -> Result<Option<DraftWithCandidates>> {
        let Some(draft) = self
            .conn
            .query_row("SELECT * FROM drafts WHERE id = ?", [id], draft_from_row)
            .optional()?
        else {
            return Ok(None);
        };
        Ok(Some(DraftWithCandidates {
            candidates: self.candidates_for_draft(id)?,
            draft,
        }))
    }

    pub fn list_drafts(&self, account_id: Option<&str>) -> Result<Vec<Draft>> {
        let mut out = Vec::new();
        match account_id {
            Some(account) => {
                let mut statement = self.conn.prepare(
                    "SELECT * FROM drafts WHERE account_id = ? ORDER BY created_at DESC",
                )?;
                let rows = statement.query_map([account], draft_from_row)?;
                for row in rows {
                    out.push(row?);
                }
            }
            None => {
                let mut statement = self
                    .conn
                    .prepare("SELECT * FROM drafts ORDER BY created_at DESC")?;
                let rows = statement.query_map([], draft_from_row)?;
                for row in rows {
                    out.push(row?);
                }
            }
        }
        Ok(out)
    }

    pub fn count_pending_drafts(&self) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM drafts WHERE status IN ('created', 'generated', 'selected')",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn delete_draft(&self, draft_id: &str) -> Result<DraftWithCandidates> {
        self.transaction(|| {
            let draft = self
                .get_draft(draft_id)?
                .ok_or_else(|| StorageError::NotFound(draft_id.to_string()))?;
            let candidates = draft.candidates.clone();

            let history: Option<String> = self
                .conn
                .query_row(
                    "SELECT id FROM post_history WHERE draft_id = ? LIMIT 1",
                    [draft_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(history_id) = history {
                return Err(StorageError::Invalid(format!(
                    "Cannot delete draft with post history: {history_id}"
                )));
            }

            let blocked: Option<(String, String)> = self
                .conn
                .query_row(
                    "SELECT id, status FROM post_jobs
                     WHERE draft_id = ? AND status IN ('running', 'posted')
                     LIMIT 1",
                    [draft_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((job_id, status)) = blocked {
                return Err(StorageError::Invalid(format!(
                    "Cannot delete draft with {status} job: {job_id}"
                )));
            }

            self.conn.execute(
                "DELETE FROM post_attempts WHERE job_id IN (SELECT id FROM post_jobs WHERE draft_id = ?)",
                [draft_id],
            )?;
            self.conn
                .execute("DELETE FROM post_jobs WHERE draft_id = ?", [draft_id])?;
            self.conn.execute(
                "DELETE FROM draft_candidates WHERE draft_id = ?",
                [draft_id],
            )?;
            self.conn.execute("DELETE FROM drafts WHERE id = ?", [draft_id])?;

            Ok(DraftWithCandidates {
                draft: draft.draft,
                candidates,
            })
        })
    }

    pub fn save_draft_candidates(
        &self,
        draft_id: &str,
        candidates: &[crate::model::NewCandidate],
    ) -> Result<DraftWithCandidates> {
        self.transaction(|| {
            let draft = self
                .get_draft(draft_id)?
                .ok_or_else(|| StorageError::NotFound(draft_id.to_string()))?;
            if draft.draft.status != DraftStatus::Created {
                return Err(StorageError::Invalid(format!(
                    "Cannot save candidates for draft with status: {}",
                    draft.draft.status
                )));
            }

            let timestamp = self.now();
            let first_text = candidates.first().map(|candidate| candidate.text.clone());

            for (index, candidate) in candidates.iter().enumerate() {
                let mut score = candidate.score.clone();
                score.insert("index".to_string(), Value::from(index));
                self.conn.execute(
                    "INSERT INTO draft_candidates (id, draft_id, text, score_json, selected, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)",
                    params![
                        new_id("candidate"),
                        draft_id,
                        candidate.text,
                        Value::Object(score).to_string(),
                        i64::from(index == 0),
                        timestamp,
                    ],
                )?;
            }

            self.conn.execute(
                "UPDATE drafts SET generated_text = ?, edited_text = ?, status = ?, updated_at = ?
                 WHERE id = ?",
                params![
                    first_text,
                    first_text,
                    if first_text.is_some() { "selected" } else { "created" },
                    timestamp,
                    draft_id,
                ],
            )?;

            self.get_draft(draft_id)?
                .ok_or_else(|| StorageError::NotFound(draft_id.to_string()))
        })
    }

    pub fn update_draft_metadata(
        &self,
        draft_id: &str,
        metadata: &Map<String, Value>,
    ) -> Result<Draft> {
        let updated = self.conn.execute(
            "UPDATE drafts SET metadata_json = ?, updated_at = ? WHERE id = ?",
            params![
                Value::Object(metadata.clone()).to_string(),
                self.now(),
                draft_id
            ],
        )?;
        if updated == 0 {
            return Err(StorageError::NotFound(draft_id.to_string()));
        }
        self.get_draft(draft_id)?
            .map(|result| result.draft)
            .ok_or_else(|| StorageError::NotFound(draft_id.to_string()))
    }

    pub fn select_candidate(
        &self,
        draft_id: &str,
        candidate_id: &str,
        edited_text: Option<&str>,
    ) -> Result<DraftWithCandidates> {
        self.transaction(|| {
            let draft = self
                .get_draft(draft_id)?
                .ok_or_else(|| StorageError::NotFound(draft_id.to_string()))?;
            let Some(candidate) = draft
                .candidates
                .iter()
                .find(|candidate| candidate.id == candidate_id)
            else {
                return Err(StorageError::NotFound(candidate_id.to_string()));
            };

            let text = edited_text.unwrap_or(&candidate.text);
            self.conn.execute(
                "UPDATE draft_candidates SET selected = (id = ?) WHERE draft_id = ?",
                params![candidate_id, draft_id],
            )?;
            self.conn.execute(
                "UPDATE drafts SET edited_text = ?, status = ?, updated_at = ? WHERE id = ?",
                params![text, DraftStatus::Selected.as_str(), self.now(), draft_id],
            )?;

            self.get_draft(draft_id)?
                .ok_or_else(|| StorageError::NotFound(draft_id.to_string()))
        })
    }

    // --- approval ------------------------------------------------------

    pub fn approve_draft(&self, input: &ApproveDraft) -> Result<(Draft, PostJob)> {
        self.transaction(|| {
            let draft_with_candidates = self
                .get_draft(&input.draft_id)?
                .ok_or_else(|| StorageError::NotFound(input.draft_id.clone()))?;
            let draft = draft_with_candidates.draft;

            if !can_transition_draft(draft.status, DraftStatus::Approved) {
                return Err(StorageError::Invalid(format!(
                    "Cannot approve draft from status: {}",
                    draft.status
                )));
            }

            let timestamp = self.now();
            let text_hash = hash_post_text(&input.edited_text);

            // The draft row is the duplicate index: one approved draft per
            // (account, text hash). `drafts.text_hash` replaced content_fingerprints.
            let duplicate: Option<String> = self
                .conn
                .query_row(
                    "SELECT id FROM drafts
                     WHERE account_id = ? AND text_hash = ? AND status = 'approved' AND id <> ?
                     LIMIT 1",
                    params![draft.account_id, text_hash, input.draft_id],
                    |row| row.get(0),
                )
                .optional()?;
            if duplicate.is_some() {
                return Err(StorageError::Invalid(
                    "Duplicate post text for this account".to_string(),
                ));
            }

            self.conn.execute(
                "UPDATE drafts SET edited_text = ?, text_hash = ?, status = ?, updated_at = ? WHERE id = ?",
                params![
                    input.edited_text,
                    text_hash,
                    DraftStatus::Approved.as_str(),
                    timestamp,
                    input.draft_id
                ],
            )?;

            let mode = input.mode.unwrap_or(if input.scheduled_for.is_some() {
                PostingMode::Scheduled
            } else {
                PostingMode::PrepareOnly
            });

            let mut scheduled_for = input.scheduled_for.clone();
            if scheduled_for.is_none() && mode == PostingMode::Autopost {
                scheduled_for = Some(self.next_autopost_slot(&draft.account_id, &timestamp)?);
            }

            let reply_to = input
                .reply_to
                .clone()
                .or(draft.reply_to.clone())
                .or_else(|| {
                    input
                        .reply_to_url
                        .as_deref()
                        .and_then(parse_reply_target_url)
                });

            let job = PostJob {
                id: new_id("job"),
                account_id: draft.account_id.clone(),
                draft_id: draft.id.clone(),
                status: PostJobStatus::Approved,
                mode,
                scheduled_for,
                reply_to,
                reply_to_url: input.reply_to_url.clone().or(draft.reply_to_url.clone()),
                approved_at: Some(timestamp.clone()),
                created_at: timestamp.clone(),
                updated_at: timestamp.clone(),
            };

            self.conn.execute(
                "INSERT INTO post_jobs (
                   id, account_id, draft_id, status, mode, scheduled_for, reply_to_json,
                   reply_to_url, approved_at, created_at, updated_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    job.id,
                    job.account_id,
                    job.draft_id,
                    job.status.as_str(),
                    job.mode.as_str(),
                    job.scheduled_for,
                    serialize_reply_target(job.reply_to.as_ref())?,
                    job.reply_to_url,
                    job.approved_at,
                    job.created_at,
                    job.updated_at,
                ],
            )?;

            let updated = self
                .get_draft(&input.draft_id)?
                .map(|result| result.draft)
                .ok_or_else(|| StorageError::NotFound(input.draft_id.clone()))?;
            Ok((updated, job))
        })
    }

    fn next_autopost_slot(&self, account_id: &str, timestamp: &str) -> Result<String> {
        let mut statement = self.conn.prepare(
            "SELECT scheduled_for, created_at FROM post_jobs
             WHERE account_id = ? AND mode = 'autopost'
             ORDER BY created_at DESC LIMIT 5",
        )?;
        let rows = statement.query_map([account_id], |row| {
            Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?))
        })?;

        let mut recent: Vec<(Option<String>, String)> = Vec::new();
        for row in rows {
            recent.push(row?);
        }
        let last_scheduled_for = recent.first().and_then(|(scheduled, _)| scheduled.clone());

        let mut recent_gap_ms = Vec::new();
        for window in recent.windows(2) {
            if let [curr, next] = window {
                let curr_ms = parse_ms(curr.0.as_deref().unwrap_or(curr.1.as_str()));
                let next_ms = parse_ms(next.0.as_deref().unwrap_or(next.1.as_str()));
                if let (Some(a), Some(b)) = (curr_ms, next_ms) {
                    recent_gap_ms.push((a - b).abs());
                }
            }
        }

        let gap_min = env_number("ZYQUOR_POST_GAP_MIN_MINUTES", 30.0);
        let gap_max = env_number("ZYQUOR_POST_GAP_MAX_MINUTES", 90.0);

        let result = next_autopost_scheduled_for(&NextAutopostInput {
            last_scheduled_for,
            timestamp: timestamp.to_string(),
            gap_min_minutes: Some(gap_min),
            gap_max_minutes: Some(gap_max),
            recent_gap_ms: Some(recent_gap_ms),
            ..Default::default()
        })
        .map_err(|error| StorageError::Invalid(error.to_string()))?;

        Ok(result.scheduled_for)
    }

    // --- jobs ----------------------------------------------------------

    pub fn get_job(&self, id: &str) -> Result<Option<PostJob>> {
        Ok(self
            .conn
            .query_row("SELECT * FROM post_jobs WHERE id = ?", [id], job_from_row)
            .optional()?)
    }

    pub fn list_jobs(
        &self,
        account_id: Option<&str>,
        statuses: Option<&[PostJobStatus]>,
        limit: Option<i64>,
    ) -> Result<Vec<PostJob>> {
        let mut sql = String::from("SELECT * FROM post_jobs WHERE 1 = 1");
        let mut args: Vec<String> = Vec::new();
        if let Some(account) = account_id {
            sql.push_str(" AND account_id = ?");
            args.push(account.to_string());
        }
        if let Some(statuses) = statuses.filter(|statuses| !statuses.is_empty()) {
            let placeholders = vec!["?"; statuses.len()].join(", ");
            sql.push_str(&format!(" AND status IN ({placeholders})"));
            args.extend(statuses.iter().map(|status| status.as_str().to_string()));
        }
        sql.push_str(" ORDER BY created_at DESC");
        if let Some(limit) = limit {
            sql.push_str(&format!(" LIMIT {limit}"));
        }

        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(rusqlite::params_from_iter(args.iter()), job_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_latest_posted_job(&self) -> Result<Option<PostJob>> {
        Ok(self
            .conn
            .query_row(
                "SELECT * FROM post_jobs WHERE status = 'posted' ORDER BY updated_at DESC LIMIT 1",
                [],
                job_from_row,
            )
            .optional()?)
    }

    pub fn get_post_job_status_counts(&self) -> Result<std::collections::BTreeMap<String, i64>> {
        let mut statement = self
            .conn
            .prepare("SELECT status, COUNT(*) FROM post_jobs GROUP BY status")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut out = std::collections::BTreeMap::new();
        for row in rows {
            let (status, count) = row?;
            out.insert(status, count);
        }
        Ok(out)
    }

    pub fn update_job_status(&self, id: &str, status: PostJobStatus) -> Result<PostJob> {
        let changed = self.conn.execute(
            "UPDATE post_jobs SET status = ?, updated_at = ? WHERE id = ?",
            params![status.as_str(), self.now(), id],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(id.to_string()));
        }
        self.get_job(id)?
            .ok_or_else(|| StorageError::NotFound(id.to_string()))
    }

    pub fn assign_job_schedule(&self, id: &str, scheduled_for: Option<&str>) -> Result<PostJob> {
        let changed = self.conn.execute(
            "UPDATE post_jobs SET scheduled_for = ?, updated_at = ? WHERE id = ?",
            params![scheduled_for, self.now(), id],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(id.to_string()));
        }
        self.get_job(id)?
            .ok_or_else(|| StorageError::NotFound(id.to_string()))
    }

    /// Claims a job for a browser run, but only when the account has no other
    /// queued or running job. The claimed status is `queued`, matching the
    /// TypeScript implementation.
    pub fn claim_job_for_browser_run(
        &self,
        job_id: &str,
        claimable: &[PostJobStatus],
    ) -> Result<Option<PostJob>> {
        if claimable.is_empty() {
            return Ok(None);
        }
        self.transaction(|| {
            let placeholders = vec!["?"; claimable.len()].join(", ");
            let sql = format!(
                "UPDATE post_jobs
                 SET status = 'queued', updated_at = ?
                 WHERE id = ?
                   AND status IN ({placeholders})
                   AND NOT EXISTS (
                     SELECT 1 FROM post_jobs active
                     WHERE active.account_id = post_jobs.account_id
                       AND active.id != post_jobs.id
                       AND active.status IN ('queued', 'running')
                   )"
            );

            let mut args: Vec<String> = vec![self.now(), job_id.to_string()];
            args.extend(claimable.iter().map(|status| status.as_str().to_string()));

            let changed = self
                .conn
                .execute(&sql, rusqlite::params_from_iter(args.iter()))?;
            if changed == 0 {
                return Ok(None);
            }
            self.get_job(job_id)
        })
    }

    // --- attempts ------------------------------------------------------

    pub fn create_attempt(&self, input: &NewAttempt) -> Result<PostAttempt> {
        let attempt = PostAttempt {
            id: new_id("attempt"),
            job_id: input.job_id.clone(),
            status: input.status,
            error_code: input.error_code.clone(),
            error_message: input.error_message.clone(),
            screenshot_path: input.screenshot_path.clone(),
            trace_path: input.trace_path.clone(),
            started_at: self.now(),
            finished_at: None,
        };
        self.conn.execute(
            "INSERT INTO post_attempts (
               id, job_id, status, error_code, error_message, screenshot_path,
               trace_path, started_at, finished_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                attempt.id,
                attempt.job_id,
                attempt.status.as_str(),
                attempt.error_code,
                attempt.error_message,
                attempt.screenshot_path,
                attempt.trace_path,
                attempt.started_at,
                attempt.finished_at,
            ],
        )?;
        Ok(attempt)
    }

    pub fn list_attempts(&self, job_id: &str) -> Result<Vec<PostAttempt>> {
        let mut statement = self
            .conn
            .prepare("SELECT * FROM post_attempts WHERE job_id = ? ORDER BY started_at ASC")?;
        let rows = statement.query_map([job_id], attempt_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    // --- post history --------------------------------------------------

    pub fn create_post_history(&self, input: &NewPostHistory) -> Result<PostHistory> {
        let history = PostHistory {
            id: new_id("history"),
            account_id: input.account_id.clone(),
            draft_id: input.draft_id.clone(),
            posted_text: input.posted_text.clone(),
            post_url: input.post_url.clone(),
            source_packet_id: input.source_packet_id.clone(),
            source_type: input.source_type.clone(),
            source_title: input.source_title.clone(),
            source_url: input.source_url.clone(),
            tweet_type: input.tweet_type.clone(),
            metadata: input.metadata.clone(),
            posted_at: self.now(),
        };

        // Stored so duplicate-text checks can use the index instead of scanning.
        let text_hash = hash_post_text(&history.posted_text);
        self.conn.execute(
            "INSERT INTO post_history (
               id, account_id, draft_id, posted_text, post_url, source_packet_id,
               source_type, source_title, source_url, tweet_type, metadata_json, posted_at,
               text_hash
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                history.id,
                history.account_id,
                history.draft_id,
                history.posted_text,
                history.post_url,
                history.source_packet_id,
                history.source_type,
                history.source_title,
                history.source_url,
                history.tweet_type,
                Value::Object(history.metadata.clone()).to_string(),
                history.posted_at,
                text_hash,
            ],
        )?;
        Ok(history)
    }

    pub fn list_post_history(&self) -> Result<Vec<PostHistory>> {
        let mut statement = self
            .conn
            .prepare("SELECT * FROM post_history ORDER BY posted_at DESC")?;
        let rows = statement.query_map([], history_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn get_latest_post_history_for_account(
        &self,
        account_id: &str,
    ) -> Result<Option<PostHistory>> {
        Ok(self
            .conn
            .query_row(
                "SELECT * FROM post_history WHERE account_id = ? ORDER BY posted_at DESC LIMIT 1",
                [account_id],
                history_from_row,
            )
            .optional()?)
    }

    pub fn count_post_history_since(&self, account_id: &str, since_iso: &str) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM post_history WHERE account_id = ? AND posted_at >= ?",
            params![account_id, since_iso],
            |row| row.get(0),
        )?)
    }

    pub fn purge_post_history_older_than(&self, cutoff_iso: &str) -> Result<usize> {
        Ok(self
            .conn
            .execute("DELETE FROM post_history WHERE posted_at < ?", [cutoff_iso])?)
    }

    /// Checks approved fingerprints, then falls back to rows written before
    /// `text_hash` existed (compared on normalised text), matching the
    /// TypeScript implementation.
    pub fn has_post_history_text_hash(
        &self,
        account_id: &str,
        text_hash: &str,
        normalized_text: &str,
    ) -> Result<bool> {
        // Indexed path: every row inserted after this column exists carries text_hash.
        let hashed: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM post_history WHERE account_id = ? AND text_hash = ? LIMIT 1",
                params![account_id, text_hash],
                |row| row.get(0),
            )
            .optional()?;
        if hashed.is_some() {
            return Ok(true);
        }
        // Migration fallback: rows written before text_hash existed (bounded by
        // the 24h history TTL) are compared directly instead of silently skipped.

        let mut statement = self.conn.prepare(
            "SELECT posted_text FROM post_history WHERE account_id = ? AND text_hash IS NULL",
        )?;
        let rows = statement.query_map([account_id], |row| row.get::<_, String>(0))?;
        for row in rows {
            if normalize_post_text(&row?) == normalized_text {
                return Ok(true);
            }
        }
        Ok(false)
    }

    // --- style profiles -------------------------------------------------

    pub fn get_style_profile(&self, id: &str) -> Result<Option<StyleProfile>> {
        Ok(self
            .conn
            .query_row(
                "SELECT * FROM style_profiles WHERE id = ?",
                [id],
                style_profile_from_row,
            )
            .optional()?)
    }

    pub fn update_style_profile(
        &self,
        id: &str,
        update: &StyleProfileUpdate,
    ) -> Result<StyleProfile> {
        let mut profile = self
            .get_style_profile(id)?
            .ok_or_else(|| StorageError::NotFound(format!("style profile {id}")))?;

        if let Some(value) = &update.name {
            profile.name = value.clone();
        }
        if let Some(value) = &update.description {
            profile.description = value.clone();
        }
        if let Some(value) = &update.tone {
            profile.tone = value.clone();
        }
        if let Some(value) = &update.rules {
            profile.rules = value.clone();
        }
        if let Some(value) = &update.banned_phrases {
            profile.banned_phrases = value.clone();
        }
        if let Some(value) = &update.example_posts {
            profile.example_posts = value.clone();
        }
        profile.updated_at = self.now();

        self.conn.execute(
            "UPDATE style_profiles SET
               name = ?, description = ?, tone = ?, rules_json = ?,
               banned_phrases_json = ?, example_posts_json = ?, updated_at = ?
             WHERE id = ?",
            params![
                profile.name,
                profile.description,
                profile.tone,
                Value::Object(profile.rules.clone()).to_string(),
                json_strings(&profile.banned_phrases),
                json_strings(&profile.example_posts),
                profile.updated_at,
                profile.id,
            ],
        )?;
        Ok(profile)
    }

    // --- system feedback ------------------------------------------------

    pub fn list_system_feedback(&self, account_id: &str) -> Result<Vec<SystemFeedback>> {
        let mut statement = self.conn.prepare(
            "SELECT * FROM system_feedback WHERE account_id = ? ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([account_id], |row| {
            Ok(SystemFeedback {
                id: row.get("id")?,
                account_id: row.get("account_id")?,
                text: row.get("text")?,
                created_at: row.get("created_at")?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn add_system_feedback(&self, account_id: &str, text: &str) -> Result<SystemFeedback> {
        if self.get_account(account_id)?.is_none() {
            return Err(StorageError::Invalid(format!(
                "Account not found: {account_id}"
            )));
        }
        let item = SystemFeedback {
            id: new_id("feedback"),
            account_id: account_id.to_string(),
            text: text.to_string(),
            created_at: self.now(),
        };
        self.conn.execute(
            "INSERT INTO system_feedback (id, account_id, text, created_at) VALUES (?, ?, ?, ?)",
            params![item.id, item.account_id, item.text, item.created_at],
        )?;
        Ok(item)
    }

    pub fn delete_system_feedback(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM system_feedback WHERE id = ?", [id])?;
        Ok(())
    }

    // --- knowledge entries ----------------------------------------------

    pub fn list_knowledge_entries(&self, account_id: &str) -> Result<Vec<KnowledgeEntry>> {
        let mut statement = self.conn.prepare(
            "SELECT * FROM knowledge_entries WHERE account_id = ? ORDER BY created_at ASC, id ASC",
        )?;
        let rows = statement.query_map([account_id], knowledge_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn create_knowledge_entry(&self, input: &NewKnowledgeEntry) -> Result<KnowledgeEntry> {
        if self.get_account(&input.account_id)?.is_none() {
            return Err(StorageError::Invalid(format!(
                "Account not found: {}",
                input.account_id
            )));
        }
        let timestamp = self.now();
        let entry = KnowledgeEntry {
            id: new_id("knowledge"),
            account_id: input.account_id.clone(),
            kind: input.kind.clone(),
            title: input.title.clone(),
            content: input.content.clone(),
            source_url: input.source_url.clone(),
            enabled: true,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        self.conn.execute(
            "INSERT INTO knowledge_entries (
               id, account_id, kind, title, content, source_url, enabled, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                entry.id,
                entry.account_id,
                entry.kind,
                entry.title,
                entry.content,
                entry.source_url,
                i64::from(entry.enabled),
                entry.created_at,
                entry.updated_at,
            ],
        )?;
        Ok(entry)
    }

    pub fn update_knowledge_entry(
        &self,
        id: &str,
        update: &KnowledgeUpdate,
    ) -> Result<KnowledgeEntry> {
        let mut entry = self
            .conn
            .query_row(
                "SELECT * FROM knowledge_entries WHERE id = ?",
                [id],
                knowledge_from_row,
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(format!("knowledge entry {id}")))?;

        if let Some(value) = &update.kind {
            entry.kind = value.clone();
        }
        if let Some(value) = &update.title {
            entry.title = value.clone();
        }
        if let Some(value) = &update.content {
            entry.content = value.clone();
        }
        if let Some(value) = &update.source_url {
            entry.source_url = value.clone();
        }
        if let Some(value) = update.enabled {
            entry.enabled = value;
        }
        entry.updated_at = self.now();

        self.conn.execute(
            "UPDATE knowledge_entries SET
               kind = ?, title = ?, content = ?, source_url = ?, enabled = ?, updated_at = ?
             WHERE id = ?",
            params![
                entry.kind,
                entry.title,
                entry.content,
                entry.source_url,
                i64::from(entry.enabled),
                entry.updated_at,
                entry.id,
            ],
        )?;
        Ok(entry)
    }

    pub fn delete_knowledge_entry(&self, id: &str) -> Result<KnowledgeEntry> {
        let entry = self
            .conn
            .query_row(
                "SELECT * FROM knowledge_entries WHERE id = ?",
                [id],
                knowledge_from_row,
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(format!("knowledge entry {id}")))?;
        self.conn
            .execute("DELETE FROM knowledge_entries WHERE id = ?", [id])?;
        Ok(entry)
    }

    // --- source packets -------------------------------------------------

    pub fn create_source_packet(&self, input: &NewSourcePacket) -> Result<SourcePacket> {
        if self.get_account(&input.account_id)?.is_none() {
            return Err(StorageError::Invalid(format!(
                "Account not found: {}",
                input.account_id
            )));
        }
        let timestamp = self.now();
        let packet = SourcePacket {
            id: new_id("packet"),
            account_id: input.account_id.clone(),
            source_type: input.source_type.clone(),
            title: input.title.clone(),
            url: input.url.clone(),
            summary: input.summary.clone(),
            facts: input.facts.clone(),
            tweet_type: input.tweet_type.clone(),
            status: SourcePacketStatus::New,
            feedback: None,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        self.conn.execute(
            "INSERT INTO source_packets (
               id, account_id, source_type, title, url, summary, facts_json, tweet_type,
               status, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                packet.id,
                packet.account_id,
                packet.source_type,
                packet.title,
                packet.url,
                packet.summary,
                json_strings(&packet.facts),
                packet.tweet_type,
                packet.status.as_str(),
                packet.created_at,
                packet.updated_at,
            ],
        )?;
        Ok(packet)
    }

    pub fn get_source_packet(&self, id: &str) -> Result<Option<SourcePacket>> {
        Ok(self
            .conn
            .query_row(
                "SELECT * FROM source_packets WHERE id = ?",
                [id],
                source_packet_from_row,
            )
            .optional()?)
    }

    pub fn get_source_packet_by_url(
        &self,
        url: &str,
        account_id: Option<&str>,
    ) -> Result<Option<SourcePacket>> {
        match account_id {
            Some(account) => Ok(self
                .conn
                .query_row(
                    "SELECT * FROM source_packets WHERE url = ? AND account_id = ?",
                    params![url, account],
                    source_packet_from_row,
                )
                .optional()?),
            None => Ok(self
                .conn
                .query_row(
                    "SELECT * FROM source_packets WHERE url = ?",
                    [url],
                    source_packet_from_row,
                )
                .optional()?),
        }
    }

    pub fn list_source_packets(
        &self,
        account_id: Option<&str>,
        status: Option<SourcePacketStatus>,
        limit: Option<i64>,
    ) -> Result<Vec<SourcePacket>> {
        let mut sql = String::from("SELECT * FROM source_packets");
        let mut conditions: Vec<String> = Vec::new();
        let mut args: Vec<String> = Vec::new();

        if let Some(account) = account_id {
            conditions.push("account_id = ?".to_string());
            args.push(account.to_string());
        }
        if let Some(status) = status {
            conditions.push("status = ?".to_string());
            args.push(status.as_str().to_string());
        }
        if !conditions.is_empty() {
            sql.push_str(&format!(" WHERE {}", conditions.join(" AND ")));
        }
        sql.push_str(" ORDER BY created_at DESC");
        if let Some(limit) = limit.filter(|limit| *limit > 0) {
            sql.push_str(&format!(" LIMIT {limit}"));
        }

        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(
            rusqlite::params_from_iter(args.iter()),
            source_packet_from_row,
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn count_source_packets(&self, status: Option<SourcePacketStatus>) -> Result<i64> {
        match status {
            Some(status) => Ok(self.conn.query_row(
                "SELECT COUNT(*) FROM source_packets WHERE status = ?",
                [status.as_str()],
                |row| row.get(0),
            )?),
            None => Ok(self
                .conn
                .query_row("SELECT COUNT(*) FROM source_packets", [], |row| row.get(0))?),
        }
    }

    pub fn get_latest_source_packet(&self) -> Result<Option<SourcePacket>> {
        Ok(self
            .conn
            .query_row(
                "SELECT * FROM source_packets ORDER BY created_at DESC LIMIT 1",
                [],
                source_packet_from_row,
            )
            .optional()?)
    }

    pub fn delete_source_packet(&self, id: &str) -> Result<SourcePacket> {
        let packet = self
            .get_source_packet(id)?
            .ok_or_else(|| StorageError::NotFound(format!("source packet {id}")))?;
        self.conn
            .execute("DELETE FROM source_packets WHERE id = ?", [id])?;
        Ok(packet)
    }

    pub fn mark_source_packet_drafted(&self, id: &str) -> Result<SourcePacket> {
        self.set_source_packet_status(id, SourcePacketStatus::Drafted)
    }

    pub fn reset_source_packet(&self, id: &str) -> Result<SourcePacket> {
        self.set_source_packet_status(id, SourcePacketStatus::New)
    }

    pub fn set_source_packet_status(
        &self,
        id: &str,
        status: SourcePacketStatus,
    ) -> Result<SourcePacket> {
        let changed = self.conn.execute(
            "UPDATE source_packets SET status = ?, updated_at = ? WHERE id = ?",
            params![status.as_str(), self.now(), id],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("source packet {id}")));
        }
        self.get_source_packet(id)?
            .ok_or_else(|| StorageError::NotFound(format!("source packet {id}")))
    }

    pub fn set_source_packet_feedback(
        &self,
        id: &str,
        feedback: Option<&str>,
    ) -> Result<SourcePacket> {
        let changed = self.conn.execute(
            "UPDATE source_packets SET feedback = ?, updated_at = ? WHERE id = ?",
            params![feedback, self.now(), id],
        )?;
        if changed == 0 {
            return Err(StorageError::NotFound(format!("source packet {id}")));
        }
        self.get_source_packet(id)?
            .ok_or_else(|| StorageError::NotFound(format!("source packet {id}")))
    }

    // --- ingest runs ----------------------------------------------------

    pub fn create_ingest_run(&self, config_id: &str, account_id: &str) -> Result<IngestRun> {
        let run = IngestRun {
            id: new_id("ingest_run"),
            config_id: config_id.to_string(),
            account_id: account_id.to_string(),
            started_at: self.now(),
            finished_at: None,
            status: IngestRunStatus::Running,
            error: None,
            packets_created: 0,
        };
        self.conn.execute(
            "INSERT INTO ingest_runs (
               id, config_id, account_id, started_at, finished_at, status, error, packets_created
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                run.id,
                run.config_id,
                run.account_id,
                run.started_at,
                run.finished_at,
                run.status.as_str(),
                run.error,
                run.packets_created,
            ],
        )?;
        Ok(run)
    }

    pub fn update_ingest_run(&self, id: &str, update: &IngestRunUpdate) -> Result<IngestRun> {
        let mut run = self
            .conn
            .query_row(
                "SELECT * FROM ingest_runs WHERE id = ?",
                [id],
                ingest_run_from_row,
            )
            .optional()?
            .ok_or_else(|| StorageError::NotFound(format!("ingest run {id}")))?;

        run.status = update.status;
        if let Some(error) = &update.error {
            run.error = error.clone();
        }
        if let Some(packets) = update.packets_created {
            run.packets_created = packets;
        }
        run.finished_at = match update.status {
            IngestRunStatus::Running => None,
            _ => Some(self.now()),
        };

        self.conn.execute(
            "UPDATE ingest_runs SET status = ?, error = ?, packets_created = ?, finished_at = ? WHERE id = ?",
            params![
                run.status.as_str(),
                run.error,
                run.packets_created,
                run.finished_at,
                run.id,
            ],
        )?;
        Ok(run)
    }

    pub fn list_ingest_runs(&self, account_id: Option<&str>, limit: i64) -> Result<Vec<IngestRun>> {
        let capped = limit.clamp(0, 50);
        let mut out = Vec::new();
        match account_id {
            Some(account) => {
                let mut statement = self.conn.prepare(
                    "SELECT * FROM ingest_runs WHERE account_id = ?
                     ORDER BY started_at DESC, id DESC LIMIT ?",
                )?;
                let rows = statement.query_map(params![account, capped], ingest_run_from_row)?;
                for row in rows {
                    out.push(row?);
                }
            }
            None => {
                let mut statement = self.conn.prepare(
                    "SELECT * FROM ingest_runs ORDER BY started_at DESC, id DESC LIMIT ?",
                )?;
                let rows = statement.query_map(params![capped], ingest_run_from_row)?;
                for row in rows {
                    out.push(row?);
                }
            }
        }
        Ok(out)
    }

    pub fn recover_running_ingest_runs(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE ingest_runs SET status = 'failed', error = 'interrupted', finished_at = ?
             WHERE status = 'running'",
            [self.now()],
        )?)
    }

    // --- tweet measurements ----------------------------------------------

    pub fn upsert_tweet_measurement(
        &self,
        input: &NewTweetMeasurement,
    ) -> Result<TweetMeasurement> {
        let updated_at = self.now();
        self.conn.execute(
            "INSERT INTO tweet_measurements (
               id, account_id, tweet_id, origin, posted_at, text, has_link, source_type,
               tweet_type, views, likes, replies, reposts, bookmarks, measured_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, tweet_id) DO UPDATE SET
               origin = excluded.origin,
               posted_at = excluded.posted_at,
               text = excluded.text,
               has_link = excluded.has_link,
               source_type = excluded.source_type,
               tweet_type = excluded.tweet_type,
               views = excluded.views,
               likes = excluded.likes,
               replies = excluded.replies,
               reposts = excluded.reposts,
               bookmarks = excluded.bookmarks,
               measured_at = excluded.measured_at,
               updated_at = excluded.updated_at",
            params![
                new_id("measurement"),
                input.account_id,
                input.tweet_id,
                input.origin,
                input.posted_at,
                input.text,
                input.has_link.map(i64::from),
                input.source_type,
                input.tweet_type,
                input.views,
                input.likes,
                input.replies,
                input.reposts,
                input.bookmarks,
                updated_at,
                updated_at,
            ],
        )?;

        self.conn
            .query_row(
                "SELECT * FROM tweet_measurements WHERE account_id = ? AND tweet_id = ?",
                params![input.account_id, input.tweet_id],
                measurement_from_row,
            )
            .map_err(StorageError::from)
    }

    pub fn list_tweet_measurements(
        &self,
        account_id: Option<&str>,
    ) -> Result<Vec<TweetMeasurement>> {
        let mut out = Vec::new();
        match account_id {
            Some(account) => {
                let mut statement = self.conn.prepare(
                    "SELECT * FROM tweet_measurements WHERE account_id = ? ORDER BY posted_at DESC",
                )?;
                let rows = statement.query_map([account], measurement_from_row)?;
                for row in rows {
                    out.push(row?);
                }
            }
            None => {
                let mut statement = self
                    .conn
                    .prepare("SELECT * FROM tweet_measurements ORDER BY posted_at DESC")?;
                let rows = statement.query_map([], measurement_from_row)?;
                for row in rows {
                    out.push(row?);
                }
            }
        }
        Ok(out)
    }

    // --- ingest configs --------------------------------------------------

    pub fn create_ingest_config(&self, input: &NewIngestConfig) -> Result<IngestConfig> {
        let timestamp = self.now();
        let config = IngestConfig {
            id: new_id("ingest"),
            account_id: input.account_id.clone(),
            source_type: input.source_type.clone(),
            max_packets_per_day: input.max_packets_per_day,
            metadata: input.metadata.clone(),
            tweet_type_mix: input.tweet_type_mix.clone(),
            schedule_window_start: input.schedule_window_start.clone(),
            schedule_window_end: input.schedule_window_end.clone(),
            enabled: input.enabled,
            created_at: timestamp.clone(),
            updated_at: timestamp,
        };
        self.conn.execute(
            "INSERT INTO ingest_configs (
               id, account_id, source_type, max_packets_per_day, metadata_json,
               tweet_type_mix_json, schedule_window_start, schedule_window_end, enabled,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                config.id,
                config.account_id,
                config.source_type,
                config.max_packets_per_day,
                Value::Object(config.metadata.clone()).to_string(),
                Value::Object(config.tweet_type_mix.clone()).to_string(),
                config.schedule_window_start,
                config.schedule_window_end,
                i64::from(config.enabled),
                config.created_at,
                config.updated_at,
            ],
        )?;
        Ok(config)
    }

    pub fn get_ingest_config(&self, id: &str) -> Result<Option<IngestConfig>> {
        Ok(self
            .conn
            .query_row(
                "SELECT * FROM ingest_configs WHERE id = ?",
                [id],
                ingest_config_from_row,
            )
            .optional()?)
    }

    pub fn list_ingest_configs(&self, account_id: Option<&str>) -> Result<Vec<IngestConfig>> {
        let mut out = Vec::new();
        match account_id {
            Some(account) => {
                let mut statement = self.conn.prepare(
                    "SELECT * FROM ingest_configs WHERE account_id = ? ORDER BY created_at DESC",
                )?;
                let rows = statement.query_map([account], ingest_config_from_row)?;
                for row in rows {
                    out.push(row?);
                }
            }
            None => {
                let mut statement = self
                    .conn
                    .prepare("SELECT * FROM ingest_configs ORDER BY created_at DESC")?;
                let rows = statement.query_map([], ingest_config_from_row)?;
                for row in rows {
                    out.push(row?);
                }
            }
        }
        Ok(out)
    }

    pub fn count_ingest_configs(&self, enabled: Option<bool>) -> Result<i64> {
        match enabled {
            Some(enabled) => Ok(self.conn.query_row(
                "SELECT COUNT(*) FROM ingest_configs WHERE enabled = ?",
                [i64::from(enabled)],
                |row| row.get(0),
            )?),
            None => Ok(self
                .conn
                .query_row("SELECT COUNT(*) FROM ingest_configs", [], |row| row.get(0))?),
        }
    }

    pub fn update_ingest_config(
        &self,
        id: &str,
        update: &IngestConfigUpdate,
    ) -> Result<IngestConfig> {
        let mut config = self
            .get_ingest_config(id)?
            .ok_or_else(|| StorageError::NotFound(format!("ingest config {id}")))?;

        if let Some(value) = &update.source_type {
            config.source_type = value.clone();
        }
        if let Some(value) = update.max_packets_per_day {
            config.max_packets_per_day = value;
        }
        if let Some(value) = &update.metadata {
            config.metadata = value.clone();
        }
        if let Some(value) = &update.tweet_type_mix {
            config.tweet_type_mix = value.clone();
        }
        if let Some(value) = &update.schedule_window_start {
            config.schedule_window_start = value.clone();
        }
        if let Some(value) = &update.schedule_window_end {
            config.schedule_window_end = value.clone();
        }
        if let Some(value) = update.enabled {
            config.enabled = value;
        }
        config.updated_at = self.now();

        self.conn.execute(
            "UPDATE ingest_configs SET source_type = ?, max_packets_per_day = ?,
               metadata_json = ?, tweet_type_mix_json = ?, schedule_window_start = ?,
               schedule_window_end = ?, enabled = ?, updated_at = ?
             WHERE id = ?",
            params![
                config.source_type,
                config.max_packets_per_day,
                Value::Object(config.metadata.clone()).to_string(),
                Value::Object(config.tweet_type_mix.clone()).to_string(),
                config.schedule_window_start,
                config.schedule_window_end,
                i64::from(config.enabled),
                config.updated_at,
                config.id,
            ],
        )?;
        Ok(config)
    }

    pub fn delete_ingest_config(&self, id: &str) -> Result<IngestConfig> {
        let config = self
            .get_ingest_config(id)?
            .ok_or_else(|| StorageError::NotFound(format!("ingest config {id}")))?;
        self.conn
            .execute("DELETE FROM ingest_configs WHERE id = ?", [id])?;
        Ok(config)
    }

    fn candidates_for_draft(&self, draft_id: &str) -> Result<Vec<DraftCandidate>> {
        let mut statement = self.conn.prepare(
            "SELECT * FROM draft_candidates WHERE draft_id = ? ORDER BY created_at ASC, rowid ASC",
        )?;
        let rows = statement.query_map([draft_id], candidate_from_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}

// --- row mapping -------------------------------------------------------

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let mut statement = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names: Vec<String> = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<_, _>>()?;
    if !names.iter().any(|name| name == column) {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {definition}"))?;
    }
    Ok(())
}

fn env_number(key: &str, fallback: f64) -> f64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn parse_ms(value: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis() as f64)
}

fn serialize_reply_target(target: Option<&ReplyTarget>) -> Result<Option<String>> {
    match target {
        Some(target) => Ok(Some(serde_json::to_string(target)?)),
        None => Ok(None),
    }
}

fn deserialize_reply_target(
    json: Option<String>,
    legacy_url: Option<String>,
) -> Option<ReplyTarget> {
    if let Some(json) = json {
        if let Ok(target) = serde_json::from_str::<ReplyTarget>(&json) {
            return Some(target);
        }
    }
    legacy_url.as_deref().and_then(parse_reply_target_url)
}

fn parse_status<T: FromStr>(value: String) -> rusqlite::Result<T> {
    value
        .parse::<T>()
        .map_err(|_| rusqlite::Error::InvalidColumnType(0, value, rusqlite::types::Type::Text))
}

fn parse_json_object(value: String) -> Map<String, Value> {
    match serde_json::from_str::<Value>(&value) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

fn account_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<zyquor_accounts::Account> {
    Ok(zyquor_accounts::Account {
        id: row.get("id")?,
        handle: row.get("handle")?,
        display_name: row.get("display_name")?,
        profile_dir: row.get("profile_dir")?,
        style_profile_id: row.get("style_profile_id")?,
        posting_mode: parse_status(row.get("posting_mode")?)?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        daily_post_limit: row.get("daily_post_limit")?,
        quiet_hours_start: row.get("quiet_hours_start")?,
        quiet_hours_end: row.get("quiet_hours_end")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn draft_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Draft> {
    Ok(Draft {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        // The TypeScript mapper always reports `text`, whatever the column says.
        source_type: "text".to_string(),
        source_input: row.get("source_input")?,
        generated_text: row.get("generated_text")?,
        edited_text: row.get("edited_text")?,
        reply_to: deserialize_reply_target(row.get("reply_to_json")?, row.get("reply_to_url")?),
        reply_to_url: row.get("reply_to_url")?,
        metadata: parse_json_object(
            row.get::<_, Option<String>>("metadata_json")?
                .unwrap_or_default(),
        ),
        status: parse_status(row.get("status")?)?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn candidate_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DraftCandidate> {
    Ok(DraftCandidate {
        id: row.get("id")?,
        draft_id: row.get("draft_id")?,
        text: row.get("text")?,
        score: parse_json_object(row.get::<_, String>("score_json")?),
        selected: row.get::<_, i64>("selected")? != 0,
        created_at: row.get("created_at")?,
    })
}

fn job_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PostJob> {
    Ok(PostJob {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        draft_id: row.get("draft_id")?,
        status: parse_status(row.get("status")?)?,
        mode: parse_status(row.get("mode")?)?,
        scheduled_for: row.get("scheduled_for")?,
        reply_to: deserialize_reply_target(row.get("reply_to_json")?, row.get("reply_to_url")?),
        reply_to_url: row.get("reply_to_url")?,
        approved_at: row.get("approved_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn attempt_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PostAttempt> {
    Ok(PostAttempt {
        id: row.get("id")?,
        job_id: row.get("job_id")?,
        status: parse_status(row.get("status")?)?,
        error_code: row.get("error_code")?,
        error_message: row.get("error_message")?,
        screenshot_path: row.get("screenshot_path")?,
        trace_path: row.get("trace_path")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
    })
}

fn history_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PostHistory> {
    Ok(PostHistory {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        draft_id: row.get("draft_id")?,
        posted_text: row.get("posted_text")?,
        post_url: row.get("post_url")?,
        source_packet_id: row.get("source_packet_id")?,
        source_type: row.get("source_type")?,
        source_title: row.get("source_title")?,
        source_url: row.get("source_url")?,
        tweet_type: row.get("tweet_type")?,
        metadata: parse_json_object(
            row.get::<_, Option<String>>("metadata_json")?
                .unwrap_or_default(),
        ),
        posted_at: row.get("posted_at")?,
    })
}

fn json_strings(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

fn parse_json_strings(value: Option<String>) -> Vec<String> {
    value
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

fn style_profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StyleProfile> {
    Ok(StyleProfile {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        tone: row.get("tone")?,
        rules: parse_json_object(
            row.get::<_, Option<String>>("rules_json")?
                .unwrap_or_default(),
        ),
        banned_phrases: parse_json_strings(row.get("banned_phrases_json")?),
        example_posts: parse_json_strings(row.get("example_posts_json")?),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn knowledge_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeEntry> {
    Ok(KnowledgeEntry {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        kind: row.get("kind")?,
        title: row.get("title")?,
        content: row.get("content")?,
        source_url: row.get("source_url")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn source_packet_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourcePacket> {
    Ok(SourcePacket {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        source_type: row.get("source_type")?,
        title: row.get("title")?,
        url: row.get("url")?,
        summary: row.get("summary")?,
        facts: parse_json_strings(row.get("facts_json")?),
        tweet_type: row.get("tweet_type")?,
        status: parse_status(row.get("status")?)?,
        feedback: row.get("feedback")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn ingest_run_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<IngestRun> {
    Ok(IngestRun {
        id: row.get("id")?,
        config_id: row.get("config_id")?,
        account_id: row.get("account_id")?,
        started_at: row.get("started_at")?,
        finished_at: row.get("finished_at")?,
        status: parse_status(row.get("status")?)?,
        error: row.get("error")?,
        packets_created: row.get("packets_created")?,
    })
}

fn measurement_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TweetMeasurement> {
    Ok(TweetMeasurement {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        tweet_id: row.get("tweet_id")?,
        origin: row.get("origin")?,
        posted_at: row.get("posted_at")?,
        text: row.get("text")?,
        has_link: row
            .get::<_, Option<i64>>("has_link")?
            .map(|value| value != 0),
        source_type: row.get("source_type")?,
        tweet_type: row.get("tweet_type")?,
        views: row.get("views")?,
        likes: row.get("likes")?,
        replies: row.get("replies")?,
        reposts: row.get("reposts")?,
        bookmarks: row.get("bookmarks")?,
        measured_at: row.get("measured_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn ingest_config_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<IngestConfig> {
    Ok(IngestConfig {
        id: row.get("id")?,
        account_id: row.get("account_id")?,
        source_type: row.get("source_type")?,
        max_packets_per_day: row.get("max_packets_per_day")?,
        metadata: parse_json_object(
            row.get::<_, Option<String>>("metadata_json")?
                .unwrap_or_default(),
        ),
        tweet_type_mix: parse_json_object(
            row.get::<_, Option<String>>("tweet_type_mix_json")?
                .unwrap_or_default(),
        ),
        schedule_window_start: row.get("schedule_window_start")?,
        schedule_window_end: row.get("schedule_window_end")?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}
