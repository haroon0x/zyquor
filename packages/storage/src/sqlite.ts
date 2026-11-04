import type {
  Account,
  Draft,
  DraftCandidate,
  KnowledgeEntry,
  PostAttempt,
  PostHistory,
  PostJob,
  SourcePacket,
  StyleProfile,
  SystemFeedback
} from "@zyquor/core";
import { canTransitionDraft, canTransitionPostJob, nextAutopostScheduledFor, dataPath, parseReplyTargetUrl } from "@zyquor/core";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type { ZyquorRepository } from "./types.js";
import { id, row, rows, normalizePostText, hashPostText } from "./utils.js";
import {
  toAccount,
  toDraft,
  toCandidate,
  toJob,
  toAttempt,
  toIngestRun,
  toPostHistory,
  toTweetMeasurement,
  toStyleProfile,
  toSourcePacket,
  toSystemFeedback,
  toKnowledgeEntry,
  toIngestConfig,
  serializeReplyTarget,
  accountInsertValues
} from "./mappers.js";

export function defaultDatabasePath(): string {
  return dataPath("data", "app.sqlite");
}

interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): unknown;
    all(...values: unknown[]): unknown[];
    run(...values: unknown[]): unknown;
  };
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => DatabaseSync;
}

type PreparedStatement = ReturnType<DatabaseSync["prepare"]>;

// Statements are reused across calls; SQLite recompiles on every db.prepare() call,
// so memoizing by SQL string removes that overhead on hot read paths.
function createPreparedStatementCache(db: DatabaseSync) {
  const cache = new Map<string, PreparedStatement>();
  const rawPrepare = db.prepare.bind(db);
  return function prepare(sql: string): PreparedStatement {
    let statement = cache.get(sql);
    if (!statement) {
      statement = rawPrepare(sql) as PreparedStatement;
      cache.set(sql, statement);
    }
    return statement;
  };
}

const sqliteSchema = `
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
`;

function runTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureColumn(db: DatabaseSync, table: string, name: string, definition: string) {
  const columns = rows(db.prepare(`PRAGMA table_info(${table})`).all());
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

export interface SqliteRepositoryOptions {
  now?: () => string;
}

export async function createSqliteRepository(
  filePath = defaultDatabasePath(),
  options: SqliteRepositoryOptions = {}
): Promise<ZyquorRepository> {
  if (filePath !== ":memory:") {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const sqlite = createRequire(import.meta.url)("node:sqlite") as SqliteModule;
  const db = new sqlite.DatabaseSync(filePath);
  const prepare = createPreparedStatementCache(db);
  const now = options.now ?? (() => new Date().toISOString());

  db.exec("PRAGMA foreign_keys = ON");
  if (filePath !== ":memory:") {
    // WAL lets API reads proceed while another write is in-flight, and
    // NORMAL sync avoids fsync-per-commit on a local-first database.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 5000");
  }
  db.exec(sqliteSchema);
  ensureColumn(db, "drafts", "reply_to_json", "reply_to_json TEXT");
  ensureColumn(db, "drafts", "reply_to_url", "reply_to_url TEXT");
  ensureColumn(db, "post_jobs", "reply_to_json", "reply_to_json TEXT");
  ensureColumn(db, "post_jobs", "reply_to_url", "reply_to_url TEXT");
  ensureColumn(db, "ingest_configs", "metadata_json", "metadata_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, "source_packets", "feedback", "feedback TEXT");
  ensureColumn(db, "drafts", "text_hash", "text_hash TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_drafts_account_text_hash ON drafts(account_id, text_hash) WHERE text_hash IS NOT NULL");
  // Folded into drafts.text_hash; the table carried no independent data.
  db.exec("DROP TABLE IF EXISTS content_fingerprints");
  const historyColumns = rows(prepare("PRAGMA table_info(post_history)").all());
  const ensureHistoryColumn = (name: string, definition: string) => {
    if (!historyColumns.some((column) => column.name === name)) {
      db.exec(`ALTER TABLE post_history ADD COLUMN ${definition}`);
    }
  };
  ensureHistoryColumn("source_packet_id", "source_packet_id TEXT");
  ensureHistoryColumn("source_type", "source_type TEXT");
  ensureHistoryColumn("source_title", "source_title TEXT");
  ensureHistoryColumn("source_url", "source_url TEXT");
  ensureHistoryColumn("tweet_type", "tweet_type TEXT");
  ensureHistoryColumn("metadata_json", "metadata_json TEXT NOT NULL DEFAULT '{}'");
  // Hash of normalizePostText(posted_text); enables indexed duplicate-text checks.
  ensureHistoryColumn("text_hash", "text_hash TEXT");
  // Tiny (usually empty) partial index so the text_hash migration fallback
  // query costs nothing once all rows carry a hash. It references the column
  // above, so it can only be created after the migration has run.
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_account_no_hash ON post_history(account_id) WHERE text_hash IS NULL");

  // The five legacy tweet types were retired. Fold surviving rows into the
  // current set so validation and type filters keep working.
  for (const table of ["post_history", "source_packets", "tweet_measurements"]) {
    db.exec(`
      UPDATE ${table} SET tweet_type = CASE tweet_type
        WHEN 'news_context' THEN 'useful_info'
        WHEN 'lesson' THEN 'guide'
        WHEN 'tool' THEN 'useful_info'
        WHEN 'hiring' THEN 'useful_info'
        WHEN 'article_summary' THEN 'useful_info'
      END
      WHERE tweet_type IN ('news_context', 'lesson', 'tool', 'hiring', 'article_summary')
    `);
  }

  const styleCount = row(prepare("SELECT COUNT(*) AS count FROM style_profiles").get());
  if (Number(styleCount?.count ?? 0) === 0) {
    const timestamp = now();
    prepare(
      `INSERT INTO style_profiles (
        id, name, description, tone, rules_json, banned_phrases_json, example_posts_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "style_default",
      "Default",
      "Default concise posting style.",
      "clear, concrete, low-filler",
      "{}",
      JSON.stringify(["game changer", "unlock", "10x"]),
      "[]",
      timestamp,
      timestamp
    );
  }

  const accountCount = row(prepare("SELECT COUNT(*) AS count FROM accounts").get());
  if (Number(accountCount?.count ?? 0) === 0) {
    const timestamp = now();
    prepare(
      `INSERT INTO accounts (
        id, handle, display_name, profile_dir, style_profile_id, posting_mode, enabled,
        daily_post_limit, quiet_hours_start, quiet_hours_end, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "account_personal",
      "personal-main",
      "Personal main",
      "profiles/personal-main",
      "style_default",
      "prepare_only",
      1,
      300,
      null,
      null,
      timestamp,
      timestamp
    );
  }

  function candidatesForDraft(draftId: string) {
    return rows(
      prepare("SELECT * FROM draft_candidates WHERE draft_id = ? ORDER BY created_at ASC, rowid ASC").all(draftId)
    ).map(toCandidate);
  }

  function requireDraft(draftId: string) {
    const draft = row(prepare("SELECT * FROM drafts WHERE id = ?").get(draftId));
    if (!draft) {
      throw new Error(`Draft not found: ${draftId}`);
    }
    return toDraft(draft);
  }

  function requireJob(jobId: string) {
    const job = row(prepare("SELECT * FROM post_jobs WHERE id = ?").get(jobId));
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return toJob(job);
  }

  return {
    async listAccounts() {
      return rows(prepare("SELECT * FROM accounts ORDER BY created_at ASC").all()).map(toAccount);
    },

    async createAccount(input) {
      const duplicate = row(prepare("SELECT id FROM accounts WHERE handle = ?").get(input.handle));
      if (duplicate) {
        throw new Error(`Duplicate account handle: ${input.handle}`);
      }

      const timestamp = now();
      const account: Account = {
        id: id("account"),
        handle: input.handle,
        displayName: input.displayName,
        profileDir: input.profileDir,
        styleProfileId: "style_default",
        postingMode: "autopost",
        enabled: true,
        dailyPostLimit: 300,
        quietHoursStart: null,
        quietHoursEnd: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      prepare(
        `INSERT INTO accounts (
          id, handle, display_name, profile_dir, style_profile_id, posting_mode, enabled,
          daily_post_limit, quiet_hours_start, quiet_hours_end, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...accountInsertValues(account));
      return account;
    },

    async getAccount(accountId) {
      const account = row(prepare("SELECT * FROM accounts WHERE id = ?").get(accountId));
      return account ? toAccount(account) : null;
    },

    async deleteAccount(accountId) {
      return runTransaction(db, () => {
        const accountRow = row(prepare("SELECT * FROM accounts WHERE id = ?").get(accountId));
        if (!accountRow) {
          throw new Error(`Account not found: ${accountId}`);
        }
        const blockedJob = row(
          prepare("SELECT id FROM post_jobs WHERE account_id = ? AND status NOT IN ('posted', 'cancelled') LIMIT 1").get(accountId)
        );
        if (blockedJob) {
          throw new Error(`Cannot delete account with non-terminal job: ${String(blockedJob.id)}`);
        }

        prepare("DELETE FROM post_attempts WHERE job_id IN (SELECT id FROM post_jobs WHERE account_id = ?)").run(accountId);
        prepare("DELETE FROM post_history WHERE account_id = ?").run(accountId);
        prepare("DELETE FROM tweet_measurements WHERE account_id = ?").run(accountId);
        prepare("DELETE FROM post_jobs WHERE account_id = ?").run(accountId);
        prepare("DELETE FROM draft_candidates WHERE draft_id IN (SELECT id FROM drafts WHERE account_id = ?)").run(accountId);
        prepare("DELETE FROM drafts WHERE account_id = ?").run(accountId);
        prepare("DELETE FROM source_packets WHERE account_id = ?").run(accountId);
        prepare("DELETE FROM ingest_runs WHERE account_id = ?").run(accountId);
        prepare("DELETE FROM ingest_configs WHERE account_id = ?").run(accountId);
        prepare("DELETE FROM system_feedback WHERE account_id = ?").run(accountId);
        prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
        return toAccount(accountRow);
      });
    },

    async updateAccount(accountId, input) {
      const accountRow = row(prepare("SELECT * FROM accounts WHERE id = ?").get(accountId));
      if (!accountRow) {
        throw new Error(`Account not found: ${accountId}`);
      }
      const account = toAccount(accountRow);

      const updated: Account = {
        ...account,
        ...input,
        updatedAt: now()
      };

      prepare(
        `UPDATE accounts SET
          handle = ?,
          display_name = ?,
          profile_dir = ?,
          style_profile_id = ?,
          posting_mode = ?,
          enabled = ?,
          daily_post_limit = ?,
          quiet_hours_start = ?,
          quiet_hours_end = ?,
          updated_at = ?
         WHERE id = ?`
      ).run(
        updated.handle,
        updated.displayName,
        updated.profileDir,
        updated.styleProfileId,
        updated.postingMode,
        updated.enabled ? 1 : 0,
        updated.dailyPostLimit,
        updated.quietHoursStart,
        updated.quietHoursEnd,
        updated.updatedAt,
        updated.id
      );

      return updated;
    },

    async getStyleProfile(styleProfileId) {
      const profile = row(prepare("SELECT * FROM style_profiles WHERE id = ?").get(styleProfileId));
      return profile ? toStyleProfile(profile) : null;
    },

    async updateStyleProfile(styleProfileId, input) {
      const profileRow = row(prepare("SELECT * FROM style_profiles WHERE id = ?").get(styleProfileId));
      if (!profileRow) {
        throw new Error(`Style profile not found: ${styleProfileId}`);
      }
      const profile = toStyleProfile(profileRow);
      const updated: StyleProfile = {
        ...profile,
        ...input,
        updatedAt: now()
      };

      prepare(
        `UPDATE style_profiles SET
          name = ?,
          description = ?,
          tone = ?,
          rules_json = ?,
          banned_phrases_json = ?,
          example_posts_json = ?,
          updated_at = ?
         WHERE id = ?`
      ).run(
        updated.name,
        updated.description,
        updated.tone,
        JSON.stringify(updated.rules),
        JSON.stringify(updated.bannedPhrases),
        JSON.stringify(updated.examplePosts),
        updated.updatedAt,
        updated.id
      );

      return updated;
    },

    async createSourcePacket(input) {
      const account = row(prepare("SELECT id FROM accounts WHERE id = ?").get(input.accountId));
      if (!account) {
        throw new Error(`Account not found: ${input.accountId}`);
      }

      const timestamp = now();
      const packet: SourcePacket = {
        id: id("packet"),
        accountId: input.accountId,
        sourceType: input.sourceType,
        title: input.title,
        url: input.url ?? null,
        summary: input.summary,
        facts: input.facts,
        tweetType: input.tweetType,
        status: "new",
        createdAt: timestamp,
        updatedAt: timestamp
      };

      prepare(
        `INSERT INTO source_packets (
          id, account_id, source_type, title, url, summary, facts_json, tweet_type, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        packet.id,
        packet.accountId,
        packet.sourceType,
        packet.title,
        packet.url,
        packet.summary,
        JSON.stringify(packet.facts),
        packet.tweetType,
        packet.status,
        packet.createdAt,
        packet.updatedAt
      );

      return packet;
    },

    async getSourcePacket(id) {
      const packet = row(prepare("SELECT * FROM source_packets WHERE id = ?").get(id));
      return packet ? toSourcePacket(packet) : null;
    },

    async getSourcePacketByUrl(url, accountId) {
      const sql = accountId
        ? "SELECT * FROM source_packets WHERE url = ? AND account_id = ?"
        : "SELECT * FROM source_packets WHERE url = ?";
      const packet = accountId
        ? row(prepare(sql).get(url, accountId))
        : row(prepare(sql).get(url));
      return packet ? toSourcePacket(packet) : null;
    },

    async listSourcePackets(accountId, options = {}) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (accountId) {
        conditions.push("account_id = ?");
        params.push(accountId);
      }
      if (options.status) {
        conditions.push("status = ?");
        params.push(options.status);
      }
      const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const limitSql = typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0 ? ` LIMIT ${Math.floor(options.limit)}` : "";
      return rows(
        prepare(`SELECT * FROM source_packets${whereSql} ORDER BY created_at DESC${limitSql}`).all(...params)
      ).map(toSourcePacket);
    },

    async countSourcePackets(status) {
      const whereSql = status ? " WHERE status = ?" : "";
      const result = row(
        prepare(`SELECT COUNT(*) AS count FROM source_packets${whereSql}`).get(...(status ? [status] : []))
      );
      return Number(result?.count ?? 0);
    },

    async getLatestSourcePacket() {
      const latest = row(prepare("SELECT * FROM source_packets ORDER BY created_at DESC LIMIT 1").get());
      return latest ? toSourcePacket(latest) : null;
    },

    async deleteSourcePacket(id) {
      const packet = row(prepare("SELECT * FROM source_packets WHERE id = ?").get(id));
      if (!packet) {
        throw new Error(`Source packet not found: ${id}`);
      }
      prepare("DELETE FROM source_packets WHERE id = ?").run(id);
      return toSourcePacket(packet);
    },

    async markSourcePacketDrafted(id) {
      const packet = row(prepare("SELECT * FROM source_packets WHERE id = ?").get(id));
      if (!packet) {
        throw new Error(`Source packet not found: ${id}`);
      }

      const timestamp = now();
      prepare("UPDATE source_packets SET status = ?, updated_at = ? WHERE id = ?").run("drafted", timestamp, id);
      return toSourcePacket(row(prepare("SELECT * FROM source_packets WHERE id = ?").get(id))!);
    },

    async resetSourcePacket(id) {
      const packet = row(prepare("SELECT * FROM source_packets WHERE id = ?").get(id));
      if (!packet) {
        throw new Error(`Source packet not found: ${id}`);
      }

      const timestamp = now();
      prepare("UPDATE source_packets SET status = ?, updated_at = ? WHERE id = ?").run("new", timestamp, id);
      return toSourcePacket(row(prepare("SELECT * FROM source_packets WHERE id = ?").get(id))!);
    },

    async setSourcePacketStatus(id, status) {
      const packet = row(prepare("SELECT * FROM source_packets WHERE id = ?").get(id));
      if (!packet) {
        throw new Error(`Source packet not found: ${id}`);
      }
      prepare("UPDATE source_packets SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
      return toSourcePacket(row(prepare("SELECT * FROM source_packets WHERE id = ?").get(id))!);
    },

    async setSourcePacketFeedback(id, feedback) {
      const packet = row(prepare("SELECT * FROM source_packets WHERE id = ?").get(id));
      if (!packet) {
        throw new Error(`Source packet not found: ${id}`);
      }

      const timestamp = now();
      prepare("UPDATE source_packets SET feedback = ?, updated_at = ? WHERE id = ?").run(feedback, timestamp, id);
      return toSourcePacket(row(prepare("SELECT * FROM source_packets WHERE id = ?").get(id))!);
    },

    async listSystemFeedback(accountId) {
      return rows(prepare("SELECT * FROM system_feedback WHERE account_id = ? ORDER BY created_at DESC").all(accountId)).map(
        toSystemFeedback
      );
    },

    async addSystemFeedback(accountId, text) {
      const account = row(prepare("SELECT id FROM accounts WHERE id = ?").get(accountId));
      if (!account) {
        throw new Error(`Account not found: ${accountId}`);
      }

      const item: SystemFeedback = {
        id: id("feedback"),
        accountId,
        text,
        createdAt: now()
      };
      prepare("INSERT INTO system_feedback (id, account_id, text, created_at) VALUES (?, ?, ?, ?)").run(
        item.id,
        item.accountId,
        item.text,
        item.createdAt
      );
      return item;
    },

    async deleteSystemFeedback(id) {
      prepare("DELETE FROM system_feedback WHERE id = ?").run(id);
    },

    async listKnowledgeEntries(accountId) {
      return rows(
        prepare("SELECT * FROM knowledge_entries WHERE account_id = ? ORDER BY created_at ASC, id ASC").all(accountId)
      ).map(toKnowledgeEntry);
    },

    async createKnowledgeEntry(input) {
      const account = row(prepare("SELECT id FROM accounts WHERE id = ?").get(input.accountId));
      if (!account) {
        throw new Error(`Account not found: ${input.accountId}`);
      }
      const timestamp = now();
      const entry: KnowledgeEntry = {
        id: id("knowledge"),
        accountId: input.accountId,
        kind: input.kind,
        title: input.title,
        content: input.content,
        sourceUrl: input.sourceUrl ?? null,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      prepare(
        `INSERT INTO knowledge_entries (
           id, account_id, kind, title, content, source_url, enabled, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entry.id,
        entry.accountId,
        entry.kind,
        entry.title,
        entry.content,
        entry.sourceUrl,
        entry.enabled ? 1 : 0,
        entry.createdAt,
        entry.updatedAt
      );
      return entry;
    },

    async updateKnowledgeEntry(entryId, input) {
      const existing = row(prepare("SELECT * FROM knowledge_entries WHERE id = ?").get(entryId));
      if (!existing) {
        throw new Error(`Knowledge entry not found: ${entryId}`);
      }
      const current = toKnowledgeEntry(existing);
      const updated: KnowledgeEntry = {
        ...current,
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        updatedAt: now()
      };
      prepare(
        `UPDATE knowledge_entries SET
           kind = ?, title = ?, content = ?, source_url = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        updated.kind,
        updated.title,
        updated.content,
        updated.sourceUrl,
        updated.enabled ? 1 : 0,
        updated.updatedAt,
        entryId
      );
      return updated;
    },

    async deleteKnowledgeEntry(entryId) {
      return runTransaction(db, () => {
        const existing = row(prepare("SELECT * FROM knowledge_entries WHERE id = ?").get(entryId));
        if (!existing) {
          throw new Error(`Knowledge entry not found: ${entryId}`);
        }
        prepare("DELETE FROM knowledge_entries WHERE id = ?").run(entryId);
        return toKnowledgeEntry(existing);
      });
    },

    async createDraft(input) {
      return runTransaction(db, () => {
        const account = row(prepare("SELECT id FROM accounts WHERE id = ?").get(input.accountId));
        if (!account) {
          throw new Error(`Account not found: ${input.accountId}`);
        }
        const timestamp = now();
        const firstCandidate = input.candidates && input.candidates.length > 0 ? (input.candidates[0]?.text ?? null) : null;
        const draft: Draft = {
          id: id("draft"),
          accountId: input.accountId,
          sourceType: "text",
          sourceInput: input.sourceInput,
          generatedText: firstCandidate,
          editedText: firstCandidate,
          replyTo: input.replyTo ?? (input.replyToUrl ? (parseReplyTargetUrl(input.replyToUrl) ?? undefined) : undefined),
          replyToUrl: input.replyToUrl ?? null,
          metadata: input.metadata ?? {},
          status: firstCandidate ? "selected" : "created",
          createdAt: timestamp,
          updatedAt: timestamp
        };

        prepare(
          `INSERT INTO drafts (
            id, account_id, source_type, source_input, generated_text, edited_text, reply_to_json, reply_to_url, metadata_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          draft.id,
          draft.accountId,
          draft.sourceType,
          draft.sourceInput,
          draft.generatedText,
          draft.editedText,
          serializeReplyTarget(draft.replyTo),
          draft.replyToUrl,
          JSON.stringify(draft.metadata),
          draft.status,
          draft.createdAt,
          draft.updatedAt
        );

        const createdCandidates = (input.candidates ?? []).map((candidate, index): DraftCandidate => {
          const draftCandidate: DraftCandidate = {
            id: id("candidate"),
            draftId: draft.id,
            text: candidate.text,
            score: { ...candidate.score, index },
            selected: index === 0,
            createdAt: timestamp
          };

          prepare(
            `INSERT INTO draft_candidates (id, draft_id, text, score_json, selected, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            draftCandidate.id,
            draftCandidate.draftId,
            draftCandidate.text,
            JSON.stringify(draftCandidate.score),
            draftCandidate.selected ? 1 : 0,
            draftCandidate.createdAt
          );

          return draftCandidate;
        });

        return { draft, candidates: createdCandidates };
      });
    },

    async hasDrafts() {
      return Boolean(row(prepare("SELECT 1 FROM drafts LIMIT 1").get()));
    },

    async countPendingDrafts() {
      const result = row(prepare("SELECT COUNT(*) AS count FROM drafts WHERE status = 'created'").get());
      return Number(result?.count ?? 0);
    },

    async listPendingDrafts() {
      return rows(prepare("SELECT * FROM drafts WHERE status = 'created' ORDER BY created_at ASC").all()).map(toDraft);
    },

    async listDrafts(accountId) {
      return rows(
        prepare(
          accountId
            ? "SELECT * FROM drafts WHERE account_id = ? ORDER BY created_at DESC"
            : "SELECT * FROM drafts ORDER BY created_at DESC"
        )
        .all(...(accountId ? [accountId] : []))
      ).map(toDraft);
    },

    async listQualityGateFailedDrafts() {
      return rows(
        prepare(
          `SELECT * FROM drafts
           WHERE status IN ('created', 'generated', 'selected')
             AND json_type(metadata_json, '$.qualityGate') = 'object'
           ORDER BY created_at ASC`
        ).all()
      ).map((draftRow) => {
        const draft = toDraft(draftRow);
        return { draft, candidates: candidatesForDraft(draft.id) };
      });
    },

    async getDraft(draftId) {
      const draft = row(prepare("SELECT * FROM drafts WHERE id = ?").get(draftId));
      return draft ? { draft: toDraft(draft), candidates: candidatesForDraft(draftId) } : null;
    },

    async getDraftBySourcePacketId(sourcePacketId) {
      const candidate = row(
        prepare("SELECT * FROM draft_candidates WHERE json_extract(score_json, '$.sourcePacketId') = ? ORDER BY created_at ASC LIMIT 1").get(
          sourcePacketId
        )
      );
      if (candidate) {
        const draftId = String(candidate.draft_id);
        const draft = row(prepare("SELECT * FROM drafts WHERE id = ?").get(draftId));
        return draft ? { draft: toDraft(draft), candidates: candidatesForDraft(draftId) } : null;
      }

      const draft = row(
        prepare("SELECT * FROM drafts WHERE json_extract(metadata_json, '$.sourcePacketId') = ? ORDER BY created_at ASC LIMIT 1").get(
          sourcePacketId
        )
      );
      if (!draft) {
        return null;
      }
      const draftId = String(draft.id);
      return draft ? { draft: toDraft(draft), candidates: candidatesForDraft(draftId) } : null;
    },

    async deleteDraft(draftId) {
      return runTransaction(db, () => {
        const draft = requireDraft(draftId);
        const draftCandidates = candidatesForDraft(draftId);
        const draftJobs = rows(prepare("SELECT * FROM post_jobs WHERE draft_id = ? ORDER BY created_at ASC").all(draftId)).map(
          toJob
        );
        const historyItem = row(prepare("SELECT id FROM post_history WHERE draft_id = ? LIMIT 1").get(draftId));
        if (historyItem) {
          throw new Error(`Cannot delete draft with post history: ${String(historyItem.id)}`);
        }
        const blockedJob = draftJobs.find((job) => job.status === "running" || job.status === "posted");
        if (blockedJob) {
          throw new Error(`Cannot delete draft with ${blockedJob.status} job: ${blockedJob.id}`);
        }

        prepare("DELETE FROM post_attempts WHERE job_id IN (SELECT id FROM post_jobs WHERE draft_id = ?)").run(draftId);
        prepare("DELETE FROM post_jobs WHERE draft_id = ?").run(draftId);
        prepare("DELETE FROM draft_candidates WHERE draft_id = ?").run(draftId);
        prepare("DELETE FROM drafts WHERE id = ?").run(draftId);

        return { draft, candidates: draftCandidates };
      });
    },

    async saveDraftCandidates(draftId, candidates) {
      return runTransaction(db, () => {
        const draft = requireDraft(draftId);
        if (draft.status !== "created") {
          throw new Error(`Cannot save candidates for draft with status: ${draft.status}`);
        }
        const timestamp = now();
        const firstCandidate = candidates[0]?.text ?? null;

        prepare("UPDATE drafts SET generated_text = ?, edited_text = ?, status = ?, updated_at = ? WHERE id = ?").run(
          firstCandidate,
          firstCandidate,
          firstCandidate ? "selected" : "generated",
          timestamp,
          draftId
        );

        candidates.forEach((candidate, index) => {
          const draftCandidate = {
            id: id("candidate"),
            draftId,
            text: candidate.text,
            score: { ...candidate.score, index },
            selected: index === 0,
            createdAt: timestamp
          };

          prepare(
            `INSERT INTO draft_candidates (id, draft_id, text, score_json, selected, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).run(
            draftCandidate.id,
            draftCandidate.draftId,
            draftCandidate.text,
            JSON.stringify(draftCandidate.score),
            draftCandidate.selected ? 1 : 0,
            draftCandidate.createdAt
          );
        });

        return {
          draft: requireDraft(draftId),
          candidates: candidatesForDraft(draftId)
        };
      });
    },

    async updateCandidateScore(candidateId, score) {
      const candidate = row(prepare("SELECT * FROM draft_candidates WHERE id = ?").get(candidateId));
      if (!candidate) {
        throw new Error(`Candidate not found: ${candidateId}`);
      }
      prepare("UPDATE draft_candidates SET score_json = ? WHERE id = ?").run(JSON.stringify(score), candidateId);
      return toCandidate(row(prepare("SELECT * FROM draft_candidates WHERE id = ?").get(candidateId))!);
    },

    async updateDraftMetadata(draftId, metadata) {
      const timestamp = now();
      prepare("UPDATE drafts SET metadata_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(metadata),
        timestamp,
        draftId
      );
      return requireDraft(draftId);
    },

    async selectCandidate(input) {
      return runTransaction(db, () => {
        const draft = requireDraft(input.draftId);
        if (!canTransitionDraft(draft.status, "selected") && draft.status !== "selected") {
          throw new Error(`Cannot select candidate from draft status: ${draft.status}`);
        }

        const selectedRow = row(
          prepare("SELECT * FROM draft_candidates WHERE id = ? AND draft_id = ?").get(input.candidateId, input.draftId)
        );
        if (!selectedRow) {
          throw new Error(`Candidate not found for draft: ${input.candidateId}`);
        }

        const selected = toCandidate(selectedRow);
        const timestamp = now();
        prepare("UPDATE draft_candidates SET selected = 0 WHERE draft_id = ?").run(input.draftId);
        prepare("UPDATE draft_candidates SET selected = 1 WHERE id = ?").run(input.candidateId);
        prepare("UPDATE drafts SET generated_text = ?, edited_text = ?, status = ?, updated_at = ? WHERE id = ?").run(
          selected.text,
          input.editedText ?? selected.text,
          "selected",
          timestamp,
          input.draftId
        );

        return {
          draft: requireDraft(input.draftId),
          candidates: candidatesForDraft(input.draftId)
        };
      });
    },

    async approveDraft(input) {
      return runTransaction(db, () => {
        const draft = requireDraft(input.draftId);
        if (!canTransitionDraft(draft.status, "approved")) {
          throw new Error(`Cannot approve draft from status: ${draft.status}`);
        }
        const timestamp = now();
        const textHash = hashPostText(input.editedText);
        // The draft row itself is the duplicate index: one approved draft per
        // (account, text hash). `drafts.text_hash` replaced content_fingerprints.
        const duplicate = row(
          prepare(
            "SELECT id FROM drafts WHERE account_id = ? AND text_hash = ? AND status = 'approved' AND id <> ? LIMIT 1"
          ).get(draft.accountId, textHash, input.draftId)
        );
        if (duplicate) {
          throw new Error("Duplicate post text for this account");
        }

        prepare("UPDATE drafts SET edited_text = ?, text_hash = ?, status = ?, updated_at = ? WHERE id = ?").run(
          input.editedText,
          textHash,
          "approved",
          timestamp,
          input.draftId
        );

        const jobMode = input.mode ?? (input.scheduledFor ? "scheduled" : "prepare_only");
        let scheduledFor: string | null = input.scheduledFor ?? null;
        if (!scheduledFor && jobMode === "autopost") {
          const lastAutopost = row(
            prepare("SELECT scheduled_for FROM post_jobs WHERE account_id = ? AND mode = 'autopost' ORDER BY created_at DESC LIMIT 1").get(draft.accountId)
          );
          const lastScheduledFor = typeof lastAutopost?.scheduled_for === "string" ? lastAutopost.scheduled_for : null;
          const recentRows = rows(
            prepare(
              "SELECT scheduled_for, created_at FROM post_jobs WHERE account_id = ? AND mode = 'autopost' ORDER BY created_at DESC LIMIT 5"
            ).all(draft.accountId)
          );
          const recentGapMs: number[] = [];
          for (let i = 0; i < recentRows.length - 1; i += 1) {
            const curr = recentRows[i] as { scheduled_for?: string | null; created_at: string } | undefined;
            const next = recentRows[i + 1] as { scheduled_for?: string | null; created_at: string } | undefined;
            if (!curr || !next) continue;
            const currMs = Date.parse(curr.scheduled_for ?? curr.created_at);
            const nextMs = Date.parse(next.scheduled_for ?? next.created_at);
            if (Number.isFinite(currMs) && Number.isFinite(nextMs)) {
              recentGapMs.push(Math.abs(currMs - nextMs));
            }
          }
          const gapMinMinutes = Number(process.env.ZYQUOR_POST_GAP_MIN_MINUTES ?? 30);
          const gapMaxMinutes = Number(process.env.ZYQUOR_POST_GAP_MAX_MINUTES ?? 90);
          const next = nextAutopostScheduledFor({
            lastScheduledFor,
            timestamp,
            gapMinMinutes,
            gapMaxMinutes,
            recentGapMs
          });
          scheduledFor = next.scheduledFor;
        }
        const job: PostJob = {
          id: id("job"),
          accountId: draft.accountId,
          draftId: draft.id,
          status: "approved",
          mode: jobMode,
          scheduledFor,
          replyTo: input.replyTo ?? draft.replyTo ?? (input.replyToUrl ? (parseReplyTargetUrl(input.replyToUrl) ?? undefined) : undefined),
          replyToUrl: input.replyToUrl ?? draft.replyToUrl ?? null,
          approvedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp
        };

        prepare(
          `INSERT INTO post_jobs (
            id, account_id, draft_id, status, mode, scheduled_for, reply_to_json, reply_to_url, approved_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          job.id,
          job.accountId,
          job.draftId,
          job.status,
          job.mode,
          job.scheduledFor,
          serializeReplyTarget(job.replyTo),
          job.replyToUrl,
          job.approvedAt,
          job.createdAt,
          job.updatedAt
        );

        return { draft: requireDraft(input.draftId), job };
      });
    },

    async listJobs(accountId, options = {}) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (accountId) {
        conditions.push("account_id = ?");
        params.push(accountId);
      }
      const statuses = options.statuses && options.statuses.length > 0 ? options.statuses : null;
      if (statuses) {
        conditions.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }
      const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      const limitSql = typeof options.limit === "number" && Number.isFinite(options.limit) && options.limit > 0 ? ` LIMIT ${Math.floor(options.limit)}` : "";
      return rows(
        prepare(`SELECT * FROM post_jobs${whereSql} ORDER BY created_at ASC${limitSql}`).all(...params)
      ).map(toJob);
    },

    async getPostJobStatusCounts() {
      const result = rows(prepare("SELECT status, COUNT(*) AS count FROM post_jobs GROUP BY status").all());
      const counts: Record<string, number> = {};
      for (const item of result) {
        counts[String(item.status)] = Number(item.count);
      }
      return counts;
    },

    async hasPostJobs() {
      return Boolean(row(prepare("SELECT 1 FROM post_jobs LIMIT 1").get()));
    },

    async getLatestPostedJob() {
      const latest = row(prepare("SELECT * FROM post_jobs WHERE status = 'posted' ORDER BY updated_at DESC LIMIT 1").get());
      return latest ? toJob(latest) : null;
    },

    async listJobsByDraftId(draftId) {
      return rows(prepare("SELECT * FROM post_jobs WHERE draft_id = ? ORDER BY created_at ASC, rowid ASC").all(draftId)).map(toJob);
    },

    async getJob(jobId) {
      const job = row(prepare("SELECT * FROM post_jobs WHERE id = ?").get(jobId));
      return job ? toJob(job) : null;
    },

    async deleteJob(jobId) {
      return runTransaction(db, () => {
        const job = requireJob(jobId);
        if (job.status === "running") {
          throw new Error("Cannot delete a running job");
        }
        prepare("DELETE FROM post_attempts WHERE job_id = ?").run(jobId);
        prepare("DELETE FROM post_jobs WHERE id = ?").run(jobId);
        return job;
      });
    },

    async updateJobStatus(jobId, status) {
      const job = requireJob(jobId);
      if (!canTransitionPostJob(job.status, status) && job.status !== status) {
        throw new Error(`Cannot move job from ${job.status} to ${status}`);
      }

      const timestamp = now();
      prepare("UPDATE post_jobs SET status = ?, updated_at = ? WHERE id = ?").run(status, timestamp, jobId);
      return requireJob(jobId);
    },

    async assignJobSchedule(jobId, scheduledFor) {
      const timestamp = now();
      prepare("UPDATE post_jobs SET scheduled_for = ?, updated_at = ? WHERE id = ?").run(
        scheduledFor,
        timestamp,
        jobId
      );
      return requireJob(jobId);
    },

    async claimJobForBrowserRun(jobId, claimableStatuses) {
      if (claimableStatuses.length === 0) {
        return null;
      }
      return runTransaction(db, () => {
        const placeholders = claimableStatuses.map(() => "?").join(", ");
        const timestamp = now();
        const result = prepare(
          `UPDATE post_jobs
           SET status = ?, updated_at = ?
           WHERE id = ?
             AND status IN (${placeholders})
             AND NOT EXISTS (
               SELECT 1
               FROM post_jobs active
               WHERE active.account_id = post_jobs.account_id
                 AND active.id != post_jobs.id
                 AND active.status IN ('queued', 'running')
             )`
        ).run("queued", timestamp, jobId, ...claimableStatuses);
        if (Number((result as { changes?: unknown }).changes ?? 0) === 0) {
          return null;
        }
        return requireJob(jobId);
      });
    },

    async createAttempt(input) {
      const timestamp = now();
      const attempt: PostAttempt = {
        id: id("attempt"),
        jobId: input.jobId,
        status: input.status,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        screenshotPath: input.screenshotPath ?? null,
        tracePath: input.tracePath ?? null,
        startedAt: timestamp,
        finishedAt: input.status === "failed" || input.status === "verified" ? timestamp : null
      };

      prepare(
        `INSERT INTO post_attempts (
          id, job_id, status, error_code, error_message, screenshot_path, trace_path, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        attempt.id,
        attempt.jobId,
        attempt.status,
        attempt.errorCode,
        attempt.errorMessage,
        attempt.screenshotPath,
        attempt.tracePath,
        attempt.startedAt,
        attempt.finishedAt
      );

      return attempt;
    },

    async listAttempts(jobId) {
      return rows(prepare("SELECT * FROM post_attempts WHERE job_id = ? ORDER BY started_at ASC").all(jobId)).map(
        toAttempt
      );
    },

    async createIngestRun(input) {
      const run: import("./types.js").IngestRun = {
        id: id("ingest_run"),
        configId: input.configId,
        accountId: input.accountId,
        startedAt: now(),
        finishedAt: null,
        status: "running",
        error: null,
        packetsCreated: 0
      };
      prepare(
        `INSERT INTO ingest_runs (id, config_id, account_id, started_at, finished_at, status, error, packets_created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        run.id, run.configId, run.accountId, run.startedAt, run.finishedAt, run.status, run.error, run.packetsCreated
      );
      return run;
    },

    async updateIngestRun(runId, input) {
      const existing = row(prepare("SELECT * FROM ingest_runs WHERE id = ?").get(runId));
      if (!existing) throw new Error(`Ingest run ${runId} not found`);
      const current = toIngestRun(existing);
      const updated: import("./types.js").IngestRun = {
        ...current,
        status: input.status,
        error: input.error === undefined ? current.error : input.error,
        packetsCreated: input.packetsCreated ?? current.packetsCreated,
        finishedAt: input.status === "running" ? null : now()
      };
      prepare(
        "UPDATE ingest_runs SET status = ?, error = ?, packets_created = ?, finished_at = ? WHERE id = ?"
      ).run(updated.status, updated.error, updated.packetsCreated, updated.finishedAt, runId);
      return updated;
    },

    async listIngestRuns(accountId, limit = 50) {
      const cappedLimit = Math.min(50, Math.max(0, limit));
      const result = accountId
        ? prepare("SELECT * FROM ingest_runs WHERE account_id = ? ORDER BY started_at DESC, id DESC LIMIT ?").all(accountId, cappedLimit)
        : prepare("SELECT * FROM ingest_runs ORDER BY started_at DESC, id DESC LIMIT ?").all(cappedLimit);
      return rows(result).map(toIngestRun);
    },

    async recoverRunningIngestRuns() {
      const result = prepare(
        "UPDATE ingest_runs SET status = 'failed', error = 'interrupted', finished_at = ? WHERE status = 'running'"
      ).run(now());
      return Number((result as { changes?: unknown }).changes ?? 0);
    },

    async createPostHistory(input) {
      const history: PostHistory = {
        id: id("history"),
        accountId: input.accountId,
        draftId: input.draftId,
        metadata: input.metadata ?? {},
        postedText: input.postedText,
        postUrl: input.postUrl,
        sourcePacketId: input.sourcePacketId ?? null,
        sourceTitle: input.sourceTitle ?? null,
        sourceType: input.sourceType ?? null,
        sourceUrl: input.sourceUrl ?? null,
        tweetType: input.tweetType ?? null,
        postedAt: now()
      };

      prepare(
        `INSERT INTO post_history (
          id, account_id, draft_id, posted_text, post_url, source_packet_id, source_type, source_title, source_url, tweet_type, metadata_json, posted_at, text_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        history.id,
        history.accountId,
        history.draftId,
        history.postedText,
        history.postUrl,
        history.sourcePacketId,
        history.sourceType,
        history.sourceTitle,
        history.sourceUrl,
        history.tweetType,
        JSON.stringify(history.metadata),
        history.postedAt,
        hashPostText(history.postedText)
      );

      return history;
    },

    async listPostHistory() {
      return rows(prepare("SELECT * FROM post_history ORDER BY posted_at DESC").all()).map(toPostHistory);
    },

    async getPostHistory(id) {
      const history = row(prepare("SELECT * FROM post_history WHERE id = ?").get(id));
      return history ? toPostHistory(history) : null;
    },

    async getLatestPostHistoryForAccount(accountId) {
      const latest = row(prepare("SELECT * FROM post_history WHERE account_id = ? ORDER BY posted_at DESC LIMIT 1").get(accountId));
      return latest ? toPostHistory(latest) : null;
    },

    async countPostHistorySince(accountId, sinceIso) {
      const result = row(
        prepare("SELECT COUNT(*) AS count FROM post_history WHERE account_id = ? AND posted_at >= ?").get(accountId, sinceIso)
      );
      return Number(result?.count ?? 0);
    },

    async countPostHistoryByDraftId(draftId) {
      const result = row(prepare("SELECT COUNT(*) AS count FROM post_history WHERE draft_id = ?").get(draftId));
      return Number(result?.count ?? 0);
    },

    async countPostHistoryBySourcePacket(accountId, sourcePacketId) {
      const result = row(
        prepare("SELECT COUNT(*) AS count FROM post_history WHERE account_id = ? AND source_packet_id = ?").get(accountId, sourcePacketId)
      );
      return Number(result?.count ?? 0);
    },

    async hasPostHistoryTextHash(accountId, textHash, normalizedText) {
      // Indexed path: every row inserted after this column exists carries text_hash.
      const hashed = row(prepare("SELECT 1 FROM post_history WHERE account_id = ? AND text_hash = ? LIMIT 1").get(accountId, textHash));
      if (hashed) {
        return true;
      }
      // Migration fallback: rows written before text_hash existed (bounded by the
      // 24h history TTL) are compared in JS rather than silently skipped.
      const legacy = rows(prepare("SELECT posted_text FROM post_history WHERE account_id = ? AND text_hash IS NULL").all(accountId));
      return legacy.some((item) => normalizePostText(String(item.posted_text)) === normalizedText);
    },

    async hasPostHistorySourceUrl(accountId, sourceUrl) {
      return Boolean(
        row(prepare("SELECT 1 FROM post_history WHERE account_id = ? AND source_url = ? LIMIT 1").get(accountId, sourceUrl))
      );
    },

    async purgePostHistoryOlderThan(cutoffIso) {
      const result = prepare("DELETE FROM post_history WHERE posted_at < ?").run(cutoffIso);
      return Number((result as { changes?: unknown }).changes ?? 0);
    },

    async updatePostHistoryMetadata(id, metadata) {
      prepare("UPDATE post_history SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), id);
      const updated = row(prepare("SELECT * FROM post_history WHERE id = ?").get(id));
      return updated ? toPostHistory(updated) : null;
    },

    async upsertTweetMeasurement(input) {
      const updatedAt = now();
      // Single upsert against the UNIQUE(account_id, tweet_id) constraint: one
      // statement replaces the previous SELECT + (UPDATE or INSERT) branching.
      prepare(
        `INSERT INTO tweet_measurements (
          id, account_id, tweet_id, origin, posted_at, text, has_link, source_type, tweet_type,
          views, likes, replies, reposts, bookmarks, measured_at, updated_at
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
          updated_at = excluded.updated_at`
      ).run(
        id("measurement"),
        input.accountId,
        input.tweetId,
        input.origin,
        input.postedAt,
        input.text,
        input.hasLink == null ? null : input.hasLink ? 1 : 0,
        input.sourceType,
        input.tweetType,
        input.views,
        input.likes,
        input.replies,
        input.reposts,
        input.bookmarks,
        updatedAt,
        updatedAt
      );
      const updated = row(prepare("SELECT * FROM tweet_measurements WHERE account_id = ? AND tweet_id = ?").get(input.accountId, input.tweetId));
      return toTweetMeasurement(row(updated) as Record<string, unknown>);
    },

    async listTweetMeasurements(accountId) {
      const sql = accountId
        ? "SELECT * FROM tweet_measurements WHERE account_id = ? ORDER BY posted_at DESC"
        : "SELECT * FROM tweet_measurements ORDER BY posted_at DESC";
      const result = accountId ? prepare(sql).all(accountId) : prepare(sql).all();
      return rows(result).map(toTweetMeasurement);
    },

    async createIngestConfig(input) {
      const nowStr = now();
      const config: import("@zyquor/core").IngestConfig = {
        id: id("ingest"),
        accountId: input.accountId,
        sourceType: input.sourceType,
        maxPacketsPerDay: input.maxPacketsPerDay,
        metadata: input.metadata ?? {},
        tweetTypeMix: input.tweetTypeMix,
        scheduleWindowStart: input.scheduleWindowStart,
        scheduleWindowEnd: input.scheduleWindowEnd,
        enabled: input.enabled,
        createdAt: nowStr,
        updatedAt: nowStr
      };
      prepare(
        `INSERT INTO ingest_configs (id, account_id, source_type, max_packets_per_day, metadata_json, tweet_type_mix_json, schedule_window_start, schedule_window_end, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        config.id, config.accountId, config.sourceType, config.maxPacketsPerDay,
        JSON.stringify(config.metadata), JSON.stringify(config.tweetTypeMix), config.scheduleWindowStart, config.scheduleWindowEnd,
        config.enabled ? 1 : 0, config.createdAt, config.updatedAt
      );
      return config;
    },

    async getIngestConfig(id) {
      const rowData = prepare("SELECT * FROM ingest_configs WHERE id = ?").get(id);
      const r = row(rowData);
      return r ? toIngestConfig(r) : null;
    },

    async listIngestConfigs(accountId) {
      const sql = accountId
        ? "SELECT * FROM ingest_configs WHERE account_id = ? ORDER BY created_at DESC"
        : "SELECT * FROM ingest_configs ORDER BY created_at DESC";
      const all = accountId
        ? prepare(sql).all(accountId)
        : prepare(sql).all();
      return rows(all).map(toIngestConfig);
    },

    async countIngestConfigs(options = {}) {
      const whereSql = options.enabled === undefined ? "" : " WHERE enabled = ?";
      const enabledParam = options.enabled === true ? 1 : 0;
      const result = row(prepare(`SELECT COUNT(*) AS count FROM ingest_configs${whereSql}`).get(...(whereSql ? [enabledParam] : [])));
      return Number(result?.count ?? 0);
    },

    async updateIngestConfig(id, input) {
      const existing = prepare("SELECT * FROM ingest_configs WHERE id = ?").get(id);
      const r = row(existing);
      if (!r) throw new Error(`Ingest config ${id} not found`);
      const current = toIngestConfig(r);
      const updated: import("@zyquor/core").IngestConfig = {
        ...current,
        ...input,
        updatedAt: now()
      };
      prepare(
        `UPDATE ingest_configs SET source_type = ?, max_packets_per_day = ?, metadata_json = ?, tweet_type_mix_json = ?, schedule_window_start = ?, schedule_window_end = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        updated.sourceType, updated.maxPacketsPerDay, JSON.stringify(updated.metadata), JSON.stringify(updated.tweetTypeMix),
        updated.scheduleWindowStart, updated.scheduleWindowEnd,
        updated.enabled ? 1 : 0, updated.updatedAt, id
      );
      return updated;
    },

    async deleteIngestConfig(id) {
      const existing = prepare("SELECT * FROM ingest_configs WHERE id = ?").get(id);
      const r = row(existing);
      if (!r) throw new Error(`Ingest config ${id} not found`);
      const config = toIngestConfig(r);
      prepare("DELETE FROM ingest_configs WHERE id = ?").run(id);
      return config;
    }
  };
}
