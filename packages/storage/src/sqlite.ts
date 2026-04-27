import type {
  Account,
  Draft,
  DraftCandidate,
  PostAttempt,
  PostHistory,
  PostJob,
  SourcePacket,
  StyleProfile
} from "@zyquor/core";
import { canTransitionDraft, canTransitionPostJob } from "@zyquor/core";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ZyquorRepository } from "./types.js";
import { id, row, rows, normalizePostText, hashPostText } from "./utils.js";
import {
  toAccount,
  toDraft,
  toCandidate,
  toJob,
  toAttempt,
  toPostHistory,
  toStyleProfile,
  toSourcePacket,
  toIngestConfig
} from "./mappers.js";

export const DEFAULT_DATABASE_PATH = "data/app.sqlite";

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

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source_type TEXT NOT NULL,
  source_input TEXT NOT NULL,
  generated_text TEXT,
  edited_text TEXT,
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

CREATE TABLE IF NOT EXISTS post_history (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  draft_id TEXT NOT NULL REFERENCES drafts(id),
  posted_text TEXT NOT NULL,
  post_url TEXT,
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
CREATE INDEX IF NOT EXISTS idx_jobs_account_status ON post_jobs(account_id, status);
CREATE INDEX IF NOT EXISTS idx_attempts_job_id ON post_attempts(job_id);
CREATE INDEX IF NOT EXISTS idx_history_account_id ON post_history(account_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_hash ON content_fingerprints(text_hash);
CREATE INDEX IF NOT EXISTS idx_source_packets_account_status ON source_packets(account_id, status);

CREATE TABLE IF NOT EXISTS ingest_configs (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source_type TEXT NOT NULL,
  max_packets_per_day INTEGER NOT NULL,
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

export async function createSqliteRepository(filePath = DEFAULT_DATABASE_PATH): Promise<ZyquorRepository> {
  mkdirSync(dirname(filePath), { recursive: true });
  const sqlite = (await import("node:sqlite")) as unknown as SqliteModule;
  const db = new sqlite.DatabaseSync(filePath);
  const now = () => new Date().toISOString();

  db.exec("PRAGMA foreign_keys = ON");
  db.exec(sqliteSchema);

  const styleCount = row(db.prepare("SELECT COUNT(*) AS count FROM style_profiles").get());
  if (Number(styleCount?.count ?? 0) === 0) {
    const timestamp = now();
    db.prepare(
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

  const accountCount = row(db.prepare("SELECT COUNT(*) AS count FROM accounts").get());
  if (Number(accountCount?.count ?? 0) === 0) {
    const timestamp = now();
    db.prepare(
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
      1000,
      null,
      null,
      timestamp,
      timestamp
    );
  }

  function candidatesForDraft(draftId: string) {
    return rows(
      db.prepare("SELECT * FROM draft_candidates WHERE draft_id = ? ORDER BY created_at ASC, id ASC").all(draftId)
    ).map(toCandidate);
  }

  function requireDraft(draftId: string) {
    const draft = row(db.prepare("SELECT * FROM drafts WHERE id = ?").get(draftId));
    if (!draft) {
      throw new Error(`Draft not found: ${draftId}`);
    }
    return toDraft(draft);
  }

  function requireJob(jobId: string) {
    const job = row(db.prepare("SELECT * FROM post_jobs WHERE id = ?").get(jobId));
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    return toJob(job);
  }

  return {
    async listAccounts() {
      return rows(db.prepare("SELECT * FROM accounts ORDER BY created_at ASC").all()).map(toAccount);
    },

    async getAccount(accountId) {
      const account = row(db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId));
      return account ? toAccount(account) : null;
    },

    async updateAccount(accountId, input) {
      const accountRow = row(db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId));
      if (!accountRow) {
        throw new Error(`Account not found: ${accountId}`);
      }
      const account = toAccount(accountRow);

      const updated: Account = {
        ...account,
        ...input,
        updatedAt: now()
      };

      db.prepare(
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
      const profile = row(db.prepare("SELECT * FROM style_profiles WHERE id = ?").get(styleProfileId));
      return profile ? toStyleProfile(profile) : null;
    },

    async updateStyleProfile(styleProfileId, input) {
      const profileRow = row(db.prepare("SELECT * FROM style_profiles WHERE id = ?").get(styleProfileId));
      if (!profileRow) {
        throw new Error(`Style profile not found: ${styleProfileId}`);
      }
      const profile = toStyleProfile(profileRow);
      const updated: StyleProfile = {
        ...profile,
        ...input,
        updatedAt: now()
      };

      db.prepare(
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
      const account = row(db.prepare("SELECT id FROM accounts WHERE id = ?").get(input.accountId));
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

      db.prepare(
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
      const packet = row(db.prepare("SELECT * FROM source_packets WHERE id = ?").get(id));
      return packet ? toSourcePacket(packet) : null;
    },

    async getSourcePacketByUrl(url, accountId) {
      const sql = accountId
        ? "SELECT * FROM source_packets WHERE url = ? AND account_id = ?"
        : "SELECT * FROM source_packets WHERE url = ?";
      const packet = accountId
        ? row(db.prepare(sql).get(url, accountId))
        : row(db.prepare(sql).get(url));
      return packet ? toSourcePacket(packet) : null;
    },

    async listSourcePackets(accountId) {
      const packetRows = accountId
        ? rows(db.prepare("SELECT * FROM source_packets WHERE account_id = ? ORDER BY created_at DESC").all(accountId))
        : rows(db.prepare("SELECT * FROM source_packets ORDER BY created_at DESC").all());
      return packetRows.map(toSourcePacket);
    },

    async markSourcePacketDrafted(id) {
      const packet = row(db.prepare("SELECT * FROM source_packets WHERE id = ?").get(id));
      if (!packet) {
        throw new Error(`Source packet not found: ${id}`);
      }

      const timestamp = now();
      db.prepare("UPDATE source_packets SET status = ?, updated_at = ? WHERE id = ?").run("drafted", timestamp, id);
      return toSourcePacket(row(db.prepare("SELECT * FROM source_packets WHERE id = ?").get(id))!);
    },

    async createDraft(input) {
      return runTransaction(db, () => {
        const account = row(db.prepare("SELECT id FROM accounts WHERE id = ?").get(input.accountId));
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
          replyToUrl: input.replyToUrl ?? null,
          metadata: input.metadata ?? {},
          status: firstCandidate ? "selected" : "created",
          createdAt: timestamp,
          updatedAt: timestamp
        };

        db.prepare(
          `INSERT INTO drafts (
            id, account_id, source_type, source_input, generated_text, edited_text, reply_to_url, metadata_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          draft.id,
          draft.accountId,
          draft.sourceType,
          draft.sourceInput,
          draft.generatedText,
          draft.editedText,
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

          db.prepare(
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

    async listPendingDrafts() {
      return rows(db.prepare("SELECT * FROM drafts WHERE status = 'created' ORDER BY created_at ASC").all()).map(toDraft);
    },

    async getDraft(draftId) {
      const draft = row(db.prepare("SELECT * FROM drafts WHERE id = ?").get(draftId));
      return draft ? { draft: toDraft(draft), candidates: candidatesForDraft(draftId) } : null;
    },

    async saveDraftCandidates(draftId, candidates) {
      return runTransaction(db, () => {
        const draft = requireDraft(draftId);
        if (draft.status !== "created") {
          throw new Error(`Cannot save candidates for draft with status: ${draft.status}`);
        }

        const timestamp = now();
        const firstCandidate = candidates[0]?.text ?? null;

        db.prepare("UPDATE drafts SET generated_text = ?, edited_text = ?, status = ?, updated_at = ? WHERE id = ?").run(
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

          db.prepare(
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

    async selectCandidate(input) {
      return runTransaction(db, () => {
        const draft = requireDraft(input.draftId);
        if (!canTransitionDraft(draft.status, "selected") && draft.status !== "selected") {
          throw new Error(`Cannot select candidate from draft status: ${draft.status}`);
        }

        const selectedRow = row(
          db.prepare("SELECT * FROM draft_candidates WHERE id = ? AND draft_id = ?").get(input.candidateId, input.draftId)
        );
        if (!selectedRow) {
          throw new Error(`Candidate not found for draft: ${input.candidateId}`);
        }

        const selected = toCandidate(selectedRow);
        const timestamp = now();
        db.prepare("UPDATE draft_candidates SET selected = 0 WHERE draft_id = ?").run(input.draftId);
        db.prepare("UPDATE draft_candidates SET selected = 1 WHERE id = ?").run(input.candidateId);
        db.prepare("UPDATE drafts SET generated_text = ?, edited_text = ?, status = ?, updated_at = ? WHERE id = ?").run(
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
        const normalizedText = normalizePostText(input.editedText);
        const textHash = hashPostText(input.editedText);
        const duplicate = row(
          db.prepare("SELECT id FROM content_fingerprints WHERE account_id = ? AND text_hash = ?").get(draft.accountId, textHash)
        );
        if (duplicate) {
          throw new Error("Duplicate post text for this account");
        }

        db.prepare("UPDATE drafts SET edited_text = ?, status = ?, updated_at = ? WHERE id = ?").run(
          input.editedText,
          "approved",
          timestamp,
          input.draftId
        );

        const jobMode = input.mode ?? (input.scheduledFor ? "scheduled" : "prepare_only");
        const job: PostJob = {
          id: id("job"),
          accountId: draft.accountId,
          draftId: draft.id,
          status: "approved",
          mode: jobMode,
          scheduledFor: input.scheduledFor ?? null,
          replyToUrl: input.replyToUrl ?? null,
          approvedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp
        };

        db.prepare(
          `INSERT INTO post_jobs (
            id, account_id, draft_id, status, mode, scheduled_for, reply_to_url, approved_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          job.id,
          job.accountId,
          job.draftId,
          job.status,
          job.mode,
          job.scheduledFor,
          job.replyToUrl,
          job.approvedAt,
          job.createdAt,
          job.updatedAt
        );

        db.prepare(
          `INSERT INTO content_fingerprints (
            id, account_id, draft_id, text_hash, normalized_text, embedding_ref, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(id("fingerprint"), draft.accountId, draft.id, textHash, normalizedText, null, timestamp);

        return { draft: requireDraft(input.draftId), job };
      });
    },

    async listJobs() {
      return rows(db.prepare("SELECT * FROM post_jobs ORDER BY created_at ASC").all()).map(toJob);
    },

    async getJob(jobId) {
      const job = row(db.prepare("SELECT * FROM post_jobs WHERE id = ?").get(jobId));
      return job ? toJob(job) : null;
    },

    async deleteJob(jobId) {
      return runTransaction(db, () => {
        const job = requireJob(jobId);
        if (job.status === "running") {
          throw new Error("Cannot delete a running job");
        }
        db.prepare("DELETE FROM post_attempts WHERE job_id = ?").run(jobId);
        db.prepare("DELETE FROM post_jobs WHERE id = ?").run(jobId);
        return job;
      });
    },

    async updateJobStatus(jobId, status) {
      const job = requireJob(jobId);
      if (!canTransitionPostJob(job.status, status) && job.status !== status) {
        throw new Error(`Cannot move job from ${job.status} to ${status}`);
      }

      const timestamp = now();
      db.prepare("UPDATE post_jobs SET status = ?, updated_at = ? WHERE id = ?").run(status, timestamp, jobId);
      return requireJob(jobId);
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

      db.prepare(
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
      return rows(db.prepare("SELECT * FROM post_attempts WHERE job_id = ? ORDER BY started_at ASC").all(jobId)).map(
        toAttempt
      );
    },

    async createPostHistory(input) {
      const history: PostHistory = {
        id: id("history"),
        accountId: input.accountId,
        draftId: input.draftId,
        postedText: input.postedText,
        postUrl: input.postUrl,
        postedAt: now()
      };

      db.prepare(
        `INSERT INTO post_history (id, account_id, draft_id, posted_text, post_url, posted_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(history.id, history.accountId, history.draftId, history.postedText, history.postUrl, history.postedAt);

      return history;
    },

    async listPostHistory() {
      return rows(db.prepare("SELECT * FROM post_history ORDER BY posted_at DESC").all()).map(toPostHistory);
    },

    async createIngestConfig(input) {
      const nowStr = now();
      const config: import("@zyquor/core").IngestConfig = {
        id: id("ingest"),
        accountId: input.accountId,
        sourceType: input.sourceType,
        maxPacketsPerDay: input.maxPacketsPerDay,
        tweetTypeMix: input.tweetTypeMix,
        scheduleWindowStart: input.scheduleWindowStart,
        scheduleWindowEnd: input.scheduleWindowEnd,
        enabled: input.enabled,
        createdAt: nowStr,
        updatedAt: nowStr
      };
      db.prepare(
        `INSERT INTO ingest_configs (id, account_id, source_type, max_packets_per_day, tweet_type_mix_json, schedule_window_start, schedule_window_end, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        config.id, config.accountId, config.sourceType, config.maxPacketsPerDay,
        JSON.stringify(config.tweetTypeMix), config.scheduleWindowStart, config.scheduleWindowEnd,
        config.enabled ? 1 : 0, config.createdAt, config.updatedAt
      );
      return config;
    },

    async getIngestConfig(id) {
      const rowData = db.prepare("SELECT * FROM ingest_configs WHERE id = ?").get(id);
      const r = row(rowData);
      return r ? toIngestConfig(r) : null;
    },

    async listIngestConfigs(accountId) {
      const sql = accountId
        ? "SELECT * FROM ingest_configs WHERE account_id = ? ORDER BY created_at DESC"
        : "SELECT * FROM ingest_configs ORDER BY created_at DESC";
      const all = accountId
        ? db.prepare(sql).all(accountId)
        : db.prepare(sql).all();
      return rows(all).map(toIngestConfig);
    },

    async updateIngestConfig(id, input) {
      const existing = db.prepare("SELECT * FROM ingest_configs WHERE id = ?").get(id);
      const r = row(existing);
      if (!r) throw new Error(`Ingest config ${id} not found`);
      const current = toIngestConfig(r);
      const updated: import("@zyquor/core").IngestConfig = {
        ...current,
        ...input,
        updatedAt: now()
      };
      db.prepare(
        `UPDATE ingest_configs SET max_packets_per_day = ?, tweet_type_mix_json = ?, schedule_window_start = ?, schedule_window_end = ?, enabled = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        updated.maxPacketsPerDay, JSON.stringify(updated.tweetTypeMix),
        updated.scheduleWindowStart, updated.scheduleWindowEnd,
        updated.enabled ? 1 : 0, updated.updatedAt, id
      );
      return updated;
    },

    async deleteIngestConfig(id) {
      const existing = db.prepare("SELECT * FROM ingest_configs WHERE id = ?").get(id);
      const r = row(existing);
      if (!r) throw new Error(`Ingest config ${id} not found`);
      const config = toIngestConfig(r);
      db.prepare("DELETE FROM ingest_configs WHERE id = ?").run(id);
      return config;
    }
  };
}
