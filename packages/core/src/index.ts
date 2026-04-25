import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const POSTING_MODES = [
  "draft_only",
  "prepare_only",
  "review_required",
  "scheduled",
  "autopost"
] as const;

export const DRAFT_STATUSES = [
  "created",
  "generated",
  "selected",
  "approved",
  "archived"
] as const;

export const POST_JOB_STATUSES = [
  "created",
  "approved",
  "queued",
  "running",
  "prepared",
  "posted",
  "failed",
  "cancelled"
] as const;

export const ATTEMPT_STATUSES = [
  "started",
  "compose_opened",
  "text_inserted",
  "post_clicked",
  "verified",
  "failed"
] as const;

export type PostingMode = (typeof POSTING_MODES)[number];
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
export type PostJobStatus = (typeof POST_JOB_STATUSES)[number];
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const idSchema = z.string().min(1);
export const isoTimestampSchema = z.string().datetime({ offset: true });

export const accountSchema = z.object({
  id: idSchema,
  handle: z.string().min(1).max(64),
  displayName: z.string().min(1).max(120),
  profileDir: z.string().min(1),
  styleProfileId: idSchema,
  postingMode: z.enum(POSTING_MODES),
  enabled: z.boolean(),
  dailyPostLimit: z.number().int().positive().nullable(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

export const styleProfileSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable(),
  tone: z.string().max(240).nullable(),
  rules: z.record(z.unknown()),
  bannedPhrases: z.array(z.string().min(1)),
  examplePosts: z.array(z.string().min(1)),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

export const draftSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  sourceType: z.enum(["text"]),
  sourceInput: z.string().min(1).max(4000),
  generatedText: z.string().max(4000).nullable(),
  editedText: z.string().max(4000).nullable(),
  status: z.enum(DRAFT_STATUSES),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

export const draftCandidateSchema = z.object({
  id: idSchema,
  draftId: idSchema,
  text: z.string().min(1).max(4000),
  score: z.record(z.unknown()),
  selected: z.boolean(),
  createdAt: isoTimestampSchema
});

export const postJobSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  draftId: idSchema,
  status: z.enum(POST_JOB_STATUSES),
  mode: z.enum(POSTING_MODES),
  scheduledFor: isoTimestampSchema.nullable(),
  approvedAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

export const postAttemptSchema = z.object({
  id: idSchema,
  jobId: idSchema,
  status: z.enum(ATTEMPT_STATUSES),
  errorCode: z.string().max(120).nullable(),
  errorMessage: z.string().max(4000).nullable(),
  screenshotPath: z.string().max(1000).nullable(),
  tracePath: z.string().max(1000).nullable(),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.nullable()
});

export const postHistorySchema = z.object({
  id: idSchema,
  accountId: idSchema,
  draftId: idSchema,
  postedText: z.string().min(1).max(4000),
  postUrl: z.string().url().nullable(),
  postedAt: isoTimestampSchema
});

export const createDraftRequestSchema = z.object({
  accountId: idSchema,
  idea: z.string().min(1).max(4000),
  count: z.number().int().min(1).max(5).optional()
});

export const updateAccountRequestSchema = z.object({
  handle: z.string().min(1).max(64).optional(),
  displayName: z.string().min(1).max(120).optional(),
  profileDir: z.string().min(1).optional(),
  postingMode: z.enum(POSTING_MODES).optional(),
  enabled: z.boolean().optional(),
  dailyPostLimit: z.number().int().positive().nullable().optional(),
  quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional()
});

export const selectDraftCandidateRequestSchema = z.object({
  candidateId: idSchema,
  editedText: z.string().min(1).max(4000).optional()
});

export const approveDraftRequestSchema = z.object({
  editedText: z.string().min(1).max(4000)
});

export const prepareJobRequestSchema = z.object({
  jobId: idSchema
});

export type Account = z.infer<typeof accountSchema>;
export type StyleProfile = z.infer<typeof styleProfileSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type DraftCandidate = z.infer<typeof draftCandidateSchema>;
export type PostJob = z.infer<typeof postJobSchema>;
export type PostAttempt = z.infer<typeof postAttemptSchema>;
export type PostHistory = z.infer<typeof postHistorySchema>;
export type CreateDraftRequest = z.infer<typeof createDraftRequestSchema>;
export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;
export type SelectDraftCandidateRequest = z.infer<typeof selectDraftCandidateRequestSchema>;
export type ApproveDraftRequest = z.infer<typeof approveDraftRequestSchema>;
export type PrepareJobRequest = z.infer<typeof prepareJobRequestSchema>;

function findDotEnv(startDir = process.cwd()) {
  let current = resolve(startDir);
  for (;;) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function loadDotEnv(filePath?: string) {
  const resolvedPath = filePath ?? findDotEnv();
  if (!resolvedPath || !existsSync(resolvedPath)) {
    return;
  }

  const lines = readFileSync(resolvedPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue === undefined) {
      continue;
    }
    if (process.env[key] !== undefined) {
      continue;
    }

    const value = rawValue.replace(/^["']|["']$/g, "");
    process.env[key] = value;
  }
}

export { canTransitionDraft, canTransitionPostJob } from "./state.js";
