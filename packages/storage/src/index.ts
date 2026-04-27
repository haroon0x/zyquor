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
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_DATABASE_PATH = "data/app.sqlite";
export const DEFAULT_JSON_DATABASE_PATH = "data/app.json";

export interface DraftWithCandidates {
  draft: Draft;
  candidates: DraftCandidate[];
}

export interface ZyquorRepository {
  listAccounts(): Promise<Account[]>;
  getAccount(id: string): Promise<Account | null>;
  updateAccount(id: string, input: Partial<Omit<Account, "id" | "createdAt" | "updatedAt">>): Promise<Account>;
  getStyleProfile(id: string): Promise<StyleProfile | null>;
  updateStyleProfile(id: string, input: Partial<Omit<StyleProfile, "id" | "createdAt" | "updatedAt">>): Promise<StyleProfile>;
  createDraft(input: {
    accountId: string;
    sourceInput: string;
    candidates: Array<{ text: string; score: Record<string, unknown> }>;
  }): Promise<DraftWithCandidates>;
  createSourcePacket(input: {
    accountId: string;
    sourceType: SourcePacket["sourceType"];
    title: string;
    url?: string | null;
    summary: string;
    facts: string[];
    tweetType: SourcePacket["tweetType"];
  }): Promise<SourcePacket>;
  getSourcePacket(id: string): Promise<SourcePacket | null>;
  listSourcePackets(accountId?: string): Promise<SourcePacket[]>;
  markSourcePacketDrafted(id: string): Promise<SourcePacket>;
  getDraft(id: string): Promise<DraftWithCandidates | null>;
  selectCandidate(input: { draftId: string; candidateId: string; editedText?: string }): Promise<DraftWithCandidates>;
  approveDraft(input: {
    draftId: string;
    editedText: string;
    mode?: PostJob["mode"];
    scheduledFor?: string | null;
  }): Promise<{ draft: Draft; job: PostJob }>;
  listJobs(): Promise<PostJob[]>;
  getJob(id: string): Promise<PostJob | null>;
  deleteJob(id: string): Promise<PostJob>;
  updateJobStatus(id: string, status: PostJob["status"]): Promise<PostJob>;
  createAttempt(input: {
    jobId: string;
    status: PostAttempt["status"];
    errorCode?: string | null;
    errorMessage?: string | null;
    screenshotPath?: string | null;
    tracePath?: string | null;
  }): Promise<PostAttempt>;
  listAttempts(jobId: string): Promise<PostAttempt[]>;
  createPostHistory(input: {
    accountId: string;
    draftId: string;
    postedText: string;
    postUrl: string | null;
  }): Promise<PostHistory>;
  listPostHistory(): Promise<PostHistory[]>;
  createIngestConfig(input: {
    accountId: string;
    sourceType: SourcePacket["sourceType"];
    maxPacketsPerDay: number;
    tweetTypeMix: Record<string, number>;
    scheduleWindowStart: string;
    scheduleWindowEnd: string;
    enabled: boolean;
  }): Promise<import("@zyquor/core").IngestConfig>;
  getIngestConfig(id: string): Promise<import("@zyquor/core").IngestConfig | null>;
  listIngestConfigs(accountId?: string): Promise<import("@zyquor/core").IngestConfig[]>;
  updateIngestConfig(id: string, input: Partial<Omit<import("@zyquor/core").IngestConfig, "id" | "accountId" | "createdAt" | "updatedAt">>): Promise<import("@zyquor/core").IngestConfig>;
  deleteIngestConfig(id: string): Promise<import("@zyquor/core").IngestConfig>;
}

export interface ContentFingerprint {
  id: string;
  accountId: string;
  draftId: string;
  textHash: string;
  normalizedText: string;
  embeddingRef: string | null;
  createdAt: string;
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

function toAccount(row: Record<string, unknown>): Account {
  return {
    id: String(row.id),
    handle: String(row.handle),
    displayName: String(row.display_name),
    profileDir: String(row.profile_dir),
    styleProfileId: String(row.style_profile_id),
    postingMode: row.posting_mode as Account["postingMode"],
    enabled: Boolean(row.enabled),
    dailyPostLimit: row.daily_post_limit === null ? null : Number(row.daily_post_limit),
    quietHoursStart: row.quiet_hours_start === null ? null : String(row.quiet_hours_start),
    quietHoursEnd: row.quiet_hours_end === null ? null : String(row.quiet_hours_end),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toDraft(row: Record<string, unknown>): Draft {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    sourceType: "text",
    sourceInput: String(row.source_input),
    generatedText: row.generated_text === null ? null : String(row.generated_text),
    editedText: row.edited_text === null ? null : String(row.edited_text),
    status: row.status as Draft["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toCandidate(row: Record<string, unknown>): DraftCandidate {
  return {
    id: String(row.id),
    draftId: String(row.draft_id),
    text: String(row.text),
    score: JSON.parse(String(row.score_json)) as Record<string, unknown>,
    selected: Boolean(row.selected),
    createdAt: String(row.created_at)
  };
}

function toJob(row: Record<string, unknown>): PostJob {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    draftId: String(row.draft_id),
    status: row.status as PostJob["status"],
    mode: row.mode as PostJob["mode"],
    scheduledFor: row.scheduled_for === null ? null : String(row.scheduled_for),
    approvedAt: row.approved_at === null ? null : String(row.approved_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toAttempt(row: Record<string, unknown>): PostAttempt {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    status: row.status as PostAttempt["status"],
    errorCode: row.error_code === null ? null : String(row.error_code),
    errorMessage: row.error_message === null ? null : String(row.error_message),
    screenshotPath: row.screenshot_path === null ? null : String(row.screenshot_path),
    tracePath: row.trace_path === null ? null : String(row.trace_path),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at)
  };
}

function toPostHistory(row: Record<string, unknown>): PostHistory {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    draftId: String(row.draft_id),
    postedText: String(row.posted_text),
    postUrl: row.post_url === null ? null : String(row.post_url),
    postedAt: String(row.posted_at)
  };
}

function toStyleProfile(row: Record<string, unknown>): StyleProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    description: row.description === null ? null : String(row.description),
    tone: row.tone === null ? null : String(row.tone),
    rules: JSON.parse(String(row.rules_json)) as Record<string, unknown>,
    bannedPhrases: JSON.parse(String(row.banned_phrases_json)) as string[],
    examplePosts: JSON.parse(String(row.example_posts_json)) as string[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toSourcePacket(row: Record<string, unknown>): SourcePacket {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    sourceType: row.source_type as SourcePacket["sourceType"],
    title: String(row.title),
    url: row.url === null ? null : String(row.url),
    summary: String(row.summary),
    facts: JSON.parse(String(row.facts_json)) as string[],
    tweetType: row.tweet_type as SourcePacket["tweetType"],
    status: row.status as SourcePacket["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toIngestConfig(row: Record<string, unknown>): import("@zyquor/core").IngestConfig {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    sourceType: row.source_type as import("@zyquor/core").SourceType,
    maxPacketsPerDay: Number(row.max_packets_per_day),
    tweetTypeMix: JSON.parse(String(row.tweet_type_mix_json)) as Record<string, number>,
    scheduleWindowStart: String(row.schedule_window_start),
    scheduleWindowEnd: String(row.schedule_window_end),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function row(value: unknown): Record<string, unknown> | null {
  return value ? (value as Record<string, unknown>) : null;
}

function rows(value: unknown[]): Record<string, unknown>[] {
  return value as Record<string, unknown>[];
}

function id(prefix: string) {
  return `${prefix}_${randomUUID()}`;
}

function normalizePostText(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function hashPostText(text: string) {
  return createHash("sha256").update(normalizePostText(text)).digest("hex");
}

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
  const sqlite = (await import("node:sqlite")) as SqliteModule;
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
        const firstCandidate = input.candidates[0]?.text ?? null;
        const draft: Draft = {
          id: id("draft"),
          accountId: input.accountId,
          sourceType: "text",
          sourceInput: input.sourceInput,
          generatedText: firstCandidate,
          editedText: firstCandidate,
          status: firstCandidate ? "selected" : "generated",
          createdAt: timestamp,
          updatedAt: timestamp
        };

        db.prepare(
          `INSERT INTO drafts (
            id, account_id, source_type, source_input, generated_text, edited_text, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          draft.id,
          draft.accountId,
          draft.sourceType,
          draft.sourceInput,
          draft.generatedText,
          draft.editedText,
          draft.status,
          draft.createdAt,
          draft.updatedAt
        );

        const createdCandidates = input.candidates.map((candidate, index): DraftCandidate => {
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

    async getDraft(draftId) {
      const draft = row(db.prepare("SELECT * FROM drafts WHERE id = ?").get(draftId));
      return draft ? { draft: toDraft(draft), candidates: candidatesForDraft(draftId) } : null;
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
          approvedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp
        };

        db.prepare(
          `INSERT INTO post_jobs (
            id, account_id, draft_id, status, mode, scheduled_for, approved_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          job.id,
          job.accountId,
          job.draftId,
          job.status,
          job.mode,
          job.scheduledFor,
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
      return rows(db.prepare("SELECT * FROM post_jobs ORDER BY created_at DESC").all()).map(toJob);
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

export interface RepositorySnapshot {
  accounts: Account[];
  drafts: Draft[];
  candidates: DraftCandidate[];
  jobs: PostJob[];
  attempts: PostAttempt[];
  history: PostHistory[];
  fingerprints: ContentFingerprint[];
  sourcePackets: SourcePacket[];
  styleProfiles: StyleProfile[];
  sequence: number;
}

export interface MemoryRepositoryOptions {
  now?: () => string;
  snapshot?: Partial<RepositorySnapshot>;
  onChange?: (snapshot: RepositorySnapshot) => void;
}

export function createMemoryRepository(options: MemoryRepositoryOptions = {}): ZyquorRepository {
  const now = options.now ?? (() => new Date().toISOString());
  const styleProfile: StyleProfile = {
    id: "style_default",
    name: "Default",
    description: "Default concise posting style.",
    tone: "clear, concrete, low-filler",
    rules: {},
    bannedPhrases: ["game changer", "unlock", "10x"],
    examplePosts: [],
    createdAt: now(),
    updatedAt: now()
  };

  const defaultAccounts: Account[] = [
    {
      id: "account_personal",
      handle: "personal-main",
      displayName: "Personal main",
      profileDir: "profiles/personal-main",
      styleProfileId: styleProfile.id,
      postingMode: "prepare_only",
      enabled: true,
      dailyPostLimit: 1000,
      quietHoursStart: null,
      quietHoursEnd: null,
      createdAt: now(),
      updatedAt: now()
    }
  ];

  const accounts = new Map<string, Account>((options.snapshot?.accounts ?? defaultAccounts).map((account) => [account.id, account]));
  const styleProfiles = new Map<string, StyleProfile>(
    (options.snapshot?.styleProfiles ?? [styleProfile]).map((profile) => [profile.id, profile])
  );
  const drafts = new Map<string, Draft>((options.snapshot?.drafts ?? []).map((draft) => [draft.id, draft]));
  const candidates = new Map<string, DraftCandidate>(
    (options.snapshot?.candidates ?? []).map((candidate) => [candidate.id, candidate])
  );
  const jobs = new Map<string, PostJob>((options.snapshot?.jobs ?? []).map((job) => [job.id, job]));
  const attempts = new Map<string, PostAttempt>((options.snapshot?.attempts ?? []).map((attempt) => [attempt.id, attempt]));
  const history = new Map<string, PostHistory>((options.snapshot?.history ?? []).map((item) => [item.id, item]));
  const fingerprints = new Map<string, ContentFingerprint>(
    (options.snapshot?.fingerprints ?? []).map((item) => [item.id, item])
  );
  const sourcePackets = new Map<string, SourcePacket>(
    (options.snapshot?.sourcePackets ?? []).map((packet) => [packet.id, packet])
  );
  const ingestConfigs = new Map<string, import("@zyquor/core").IngestConfig>();
  let sequence = options.snapshot?.sequence ?? 0;

  function snapshot(): RepositorySnapshot {
    return {
      accounts: [...accounts.values()],
      drafts: [...drafts.values()],
      candidates: [...candidates.values()],
      jobs: [...jobs.values()],
      attempts: [...attempts.values()],
      history: [...history.values()],
      fingerprints: [...fingerprints.values()],
      sourcePackets: [...sourcePackets.values()],
      styleProfiles: [...styleProfiles.values()],
      sequence
    };
  }

  function persist() {
    options.onChange?.(snapshot());
  }

  function id(prefix: string) {
    sequence += 1;
    return `${prefix}_${sequence.toString().padStart(6, "0")}`;
  }

  function candidatesForDraft(draftId: string) {
    return [...candidates.values()].filter((candidate) => candidate.draftId === draftId);
  }

  function requireDraft(id: string) {
    const draft = drafts.get(id);
    if (!draft) {
      throw new Error(`Draft not found: ${id}`);
    }
    return draft;
  }

  function requireJob(id: string) {
    const job = jobs.get(id);
    if (!job) {
      throw new Error(`Job not found: ${id}`);
    }
    return job;
  }

  return {
    async listAccounts() {
      return [...accounts.values()];
    },

    async getAccount(id) {
      return accounts.get(id) ?? null;
    },

    async updateAccount(id, input) {
      const account = accounts.get(id);
      if (!account) {
        throw new Error(`Account not found: ${id}`);
      }

      const updated: Account = {
        ...account,
        ...input,
        updatedAt: now()
      };
      accounts.set(id, updated);
      persist();
      return updated;
    },

    async getStyleProfile(id) {
      return styleProfiles.get(id) ?? null;
    },

    async updateStyleProfile(id, input) {
      const profile = styleProfiles.get(id);
      if (!profile) {
        throw new Error(`Style profile not found: ${id}`);
      }

      const updated: StyleProfile = {
        ...profile,
        ...input,
        updatedAt: now()
      };
      styleProfiles.set(id, updated);
      persist();
      return updated;
    },

    async createSourcePacket(input) {
      const account = accounts.get(input.accountId);
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
      sourcePackets.set(packet.id, packet);
      persist();
      return packet;
    },

    async getSourcePacket(id) {
      return sourcePackets.get(id) ?? null;
    },

    async listSourcePackets(accountId) {
      return [...sourcePackets.values()]
        .filter((packet) => !accountId || packet.accountId === accountId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async markSourcePacketDrafted(id) {
      const packet = sourcePackets.get(id);
      if (!packet) {
        throw new Error(`Source packet not found: ${id}`);
      }
      const updated: SourcePacket = { ...packet, status: "drafted", updatedAt: now() };
      sourcePackets.set(id, updated);
      persist();
      return updated;
    },

    async createDraft(input) {
      const account = accounts.get(input.accountId);
      if (!account) {
        throw new Error(`Account not found: ${input.accountId}`);
      }

      const timestamp = now();
      const firstCandidate = input.candidates[0]?.text ?? null;
      const draft: Draft = {
        id: id("draft"),
        accountId: input.accountId,
        sourceType: "text",
        sourceInput: input.sourceInput,
        generatedText: firstCandidate,
        editedText: firstCandidate,
        status: firstCandidate ? "selected" : "generated",
        createdAt: timestamp,
        updatedAt: timestamp
      };

      drafts.set(draft.id, draft);

      const createdCandidates = input.candidates.map((candidate, index): DraftCandidate => {
        const draftCandidate = {
          id: id("candidate"),
          draftId: draft.id,
          text: candidate.text,
          score: { ...candidate.score, index },
          selected: index === 0,
          createdAt: timestamp
        };
        candidates.set(draftCandidate.id, draftCandidate);
        return draftCandidate;
      });

      persist();
      return { draft, candidates: createdCandidates };
    },

    async getDraft(id) {
      const draft = drafts.get(id);
      return draft ? { draft, candidates: candidatesForDraft(id) } : null;
    },

    async selectCandidate(input) {
      const draft = requireDraft(input.draftId);
      if (!canTransitionDraft(draft.status, "selected") && draft.status !== "selected") {
        throw new Error(`Cannot select candidate from draft status: ${draft.status}`);
      }

      const selected = candidates.get(input.candidateId);
      if (!selected || selected.draftId !== input.draftId) {
        throw new Error(`Candidate not found for draft: ${input.candidateId}`);
      }

      for (const candidate of candidatesForDraft(input.draftId)) {
        candidates.set(candidate.id, { ...candidate, selected: candidate.id === selected.id });
      }

      const timestamp = now();
      const updatedDraft: Draft = {
        ...draft,
        generatedText: selected.text,
        editedText: input.editedText ?? selected.text,
        status: "selected",
        updatedAt: timestamp
      };
      drafts.set(updatedDraft.id, updatedDraft);

      persist();
      return { draft: updatedDraft, candidates: candidatesForDraft(input.draftId) };
    },

    async approveDraft(input) {
      const draft = requireDraft(input.draftId);
      if (!canTransitionDraft(draft.status, "approved")) {
        throw new Error(`Cannot approve draft from status: ${draft.status}`);
      }

      const timestamp = now();
      const normalizedText = normalizePostText(input.editedText);
      const textHash = hashPostText(input.editedText);
      const duplicate = [...fingerprints.values()].find(
        (fingerprint) => fingerprint.accountId === draft.accountId && fingerprint.textHash === textHash
      );
      if (duplicate) {
        throw new Error("Duplicate post text for this account");
      }

      const updatedDraft: Draft = {
        ...draft,
        editedText: input.editedText,
        status: "approved",
        updatedAt: timestamp
      };
      drafts.set(updatedDraft.id, updatedDraft);

      const jobMode = input.mode ?? (input.scheduledFor ? "scheduled" : "prepare_only");
      const job: PostJob = {
        id: id("job"),
        accountId: draft.accountId,
        draftId: draft.id,
        status: "approved",
        mode: jobMode,
        scheduledFor: input.scheduledFor ?? null,
        approvedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      jobs.set(job.id, job);
      const fingerprint: ContentFingerprint = {
        id: id("fingerprint"),
        accountId: draft.accountId,
        draftId: draft.id,
        textHash,
        normalizedText,
        embeddingRef: null,
        createdAt: timestamp
      };
      fingerprints.set(fingerprint.id, fingerprint);

      persist();
      return { draft: updatedDraft, job };
    },

    async listJobs() {
      return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async getJob(id) {
      return jobs.get(id) ?? null;
    },

    async deleteJob(id) {
      const job = requireJob(id);
      if (job.status === "running") {
        throw new Error("Cannot delete a running job");
      }
      jobs.delete(id);
      for (const [attemptId, attempt] of attempts.entries()) {
        if (attempt.jobId === id) {
          attempts.delete(attemptId);
        }
      }
      persist();
      return job;
    },

    async updateJobStatus(id, status) {
      const job = requireJob(id);
      if (!canTransitionPostJob(job.status, status) && job.status !== status) {
        throw new Error(`Cannot move job from ${job.status} to ${status}`);
      }

      const updatedJob = { ...job, status, updatedAt: now() };
      jobs.set(id, updatedJob);
      persist();
      return updatedJob;
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
      attempts.set(attempt.id, attempt);
      persist();
      return attempt;
    },

    async listAttempts(jobId) {
      return [...attempts.values()].filter((attempt) => attempt.jobId === jobId);
    },

    async createPostHistory(input) {
      const item: PostHistory = {
        id: id("history"),
        accountId: input.accountId,
        draftId: input.draftId,
        postedText: input.postedText,
        postUrl: input.postUrl,
        postedAt: now()
      };
      history.set(item.id, item);
      persist();
      return item;
    },

    async listPostHistory() {
      return [...history.values()].sort((a, b) => b.postedAt.localeCompare(a.postedAt));
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
      ingestConfigs.set(config.id, config);
      persist();
      return config;
    },

    async getIngestConfig(id) {
      return ingestConfigs.get(id) ?? null;
    },

    async listIngestConfigs(accountId) {
      const all = [...ingestConfigs.values()];
      return accountId ? all.filter((c) => c.accountId === accountId) : all;
    },

    async updateIngestConfig(id, input) {
      const existing = ingestConfigs.get(id);
      if (!existing) throw new Error(`Ingest config ${id} not found`);
      const updated: import("@zyquor/core").IngestConfig = { ...existing, ...input, updatedAt: now() };
      ingestConfigs.set(id, updated);
      persist();
      return updated;
    },

    async deleteIngestConfig(id) {
      const existing = ingestConfigs.get(id);
      if (!existing) throw new Error(`Ingest config ${id} not found`);
      ingestConfigs.delete(id);
      persist();
      return existing;
    }
  };
}

export function createJsonFileRepository(filePath = DEFAULT_JSON_DATABASE_PATH): ZyquorRepository {
  mkdirSync(dirname(filePath), { recursive: true });

  let snapshot: Partial<RepositorySnapshot> | undefined;
  try {
    snapshot = JSON.parse(readFileSync(filePath, "utf8")) as RepositorySnapshot;
  } catch {
    snapshot = undefined;
  }

  return createMemoryRepository({
    ...(snapshot ? { snapshot } : {}),
    onChange(nextSnapshot) {
      writeFileSync(filePath, `${JSON.stringify(nextSnapshot, null, 2)}\n`);
    }
  });
}

export async function createLocalRepository(filePath = DEFAULT_DATABASE_PATH): Promise<ZyquorRepository> {
  try {
    return await createSqliteRepository(filePath);
  } catch {
    return createJsonFileRepository(DEFAULT_JSON_DATABASE_PATH);
  }
}
