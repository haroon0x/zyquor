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

export const TWEET_TYPES = [
  "feed_observation",
  "news_context",
  "useful_info",
  "guide",
  "lesson",
  "tool",
  "opinion",
  "reply",
  "hiring",
  "article_summary",
  "narrative_history"
] as const;

export const X_FREE_POST_CHARACTER_LIMIT = 280;

export const SOURCE_TYPES = [
  "manual",
  "news",
  "feed",
  "bookmark",
  "note",
  "guide",
  "job"
] as const;

export const LLM_PROVIDERS = [
  "command-code",
  "openrouter",
  "gemini",
  "ollama"
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
export type TweetType = (typeof TWEET_TYPES)[number];
export type SourceType = (typeof SOURCE_TYPES)[number];
export type LlmProvider = (typeof LLM_PROVIDERS)[number];
export type DraftStatus = (typeof DRAFT_STATUSES)[number];
export type PostJobStatus = (typeof POST_JOB_STATUSES)[number];
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const idSchema = z.string().min(1);
export const isoTimestampSchema = z.string().datetime({ offset: true });

export interface ReplyTarget {
  tweetId: string;
  authorHandle: string;
  url: string;
}

export const replyTargetSchema: z.ZodType<ReplyTarget> = z.object({
  tweetId: z.string().regex(/^\d+$/),
  authorHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  url: z.string().url()
});

export function parseReplyTargetUrl(url: string): ReplyTarget | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["x.com", "twitter.com"].includes(parsed.hostname)) {
      return null;
    }
    if (parsed.username || parsed.password || parsed.port) {
      return null;
    }
    const match = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/.exec(parsed.pathname);
    if (!match) {
      return null;
    }
    const authorHandle = match[1];
    const tweetId = match[2];
    if (!authorHandle || !tweetId) {
      return null;
    }
    return { tweetId, authorHandle, url };
  } catch {
    return null;
  }
}

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

export const createAccountRequestSchema = z
  .object({
    handle: z.string().regex(/^[a-z0-9_]{1,15}$/),
    displayName: z.string().min(1).max(120).optional()
  })
  .strict()
  .transform((input) => ({
    handle: input.handle,
    displayName: input.displayName ?? input.handle,
    profileDir: `profiles/${input.handle}`
  }));

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
  generatedText: z.string().max(X_FREE_POST_CHARACTER_LIMIT).nullable(),
  editedText: z.string().max(X_FREE_POST_CHARACTER_LIMIT).nullable(),
  replyTo: replyTargetSchema.optional(),
  replyToUrl: z.string().url().nullable().optional(),
  metadata: z.record(z.unknown()),
  status: z.enum(DRAFT_STATUSES),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

export const draftCandidateSchema = z.object({
  id: idSchema,
  draftId: idSchema,
  text: z.string().min(1).max(X_FREE_POST_CHARACTER_LIMIT),
  score: z.record(z.unknown()),
  selected: z.boolean(),
  createdAt: isoTimestampSchema
});

export const postJobSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  draftId: idSchema,
  replyTo: replyTargetSchema.optional(),
  replyToUrl: z.string().url().nullable().optional(),
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
  postedText: z.string().min(1).max(X_FREE_POST_CHARACTER_LIMIT),
  postUrl: z.string().url().nullable(),
  sourcePacketId: idSchema.nullable(),
  sourceType: z.enum(SOURCE_TYPES).nullable(),
  sourceTitle: z.string().max(240).nullable(),
  sourceUrl: z.string().url().nullable(),
  tweetType: z.enum(TWEET_TYPES).nullable(),
  metadata: z.record(z.unknown()),
  postedAt: isoTimestampSchema
});

export const sourcePacketSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  sourceType: z.enum(SOURCE_TYPES),
  title: z.string().min(1).max(240),
  url: z.string().url().nullable(),
  summary: z.string().min(1).max(2000),
  facts: z.array(z.string().min(1).max(500)).max(8),
  tweetType: z.enum(TWEET_TYPES),
  status: z.enum(["new", "drafted", "archived"]),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

export const createDraftRequestSchema = z.object({
  accountId: idSchema,
  idea: z.string().min(1).max(4000),
  count: z.number().int().min(1).max(5).optional(),
  tweetType: z.enum(TWEET_TYPES).optional(),
  replyToUrl: z.string().url().optional(),
  yolo: z.boolean().optional().default(false),
  autopost: z.boolean().optional().default(false)
});

export const createDraftBatchRequestSchema = z.object({
  accountId: idSchema,
  ideas: z.array(z.string().min(1).max(4000)).min(1).max(10),
  mode: z.enum(POSTING_MODES).optional(),
  scheduleSpacingMinutes: z.number().int().min(15).max(480).optional(),
  scheduleStart: isoTimestampSchema.nullable().optional(),
  replyToUrl: z.string().url().optional(),
  tweetType: z.enum(TWEET_TYPES).optional(),
  yolo: z.boolean().optional().default(false),
  autopost: z.boolean().optional().default(false)
});

export const createSourcePacketRequestSchema = z.object({
  accountId: idSchema,
  facts: z.array(z.string().min(1).max(500)).max(8).default([]),
  sourceType: z.enum(SOURCE_TYPES),
  summary: z.string().min(1).max(2000),
  title: z.string().min(1).max(240),
  tweetType: z.enum(TWEET_TYPES).default("useful_info"),
  url: z.string().url().nullable().optional()
});

export const updateGenerationConfigRequestSchema = z.object({
  provider: z.enum(LLM_PROVIDERS),
  model: z.string().min(1).max(160)
});

export const ingestConfigSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  sourceType: z.enum(SOURCE_TYPES),
  maxPacketsPerDay: z.number().int().min(1).max(1000),
  metadata: z.record(z.unknown()).default({}),
  tweetTypeMix: z.record(z.enum(TWEET_TYPES), z.number().int().min(0).max(100)),
  scheduleWindowStart: z.string().regex(/^\d{2}:\d{2}$/),
  scheduleWindowEnd: z.string().regex(/^\d{2}:\d{2}$/),
  enabled: z.boolean(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema
});

export const createIngestConfigRequestSchema = z.object({
  accountId: idSchema,
  sourceType: z.enum(SOURCE_TYPES),
  maxPacketsPerDay: z.number().int().min(1).max(1000).default(1000),
  metadata: z.record(z.unknown()).default({}),
  tweetTypeMix: z.record(z.enum(TWEET_TYPES), z.number().int().min(0).max(100)).default({}),
  scheduleWindowStart: z.string().regex(/^\d{2}:\d{2}$/).default("09:00"),
  scheduleWindowEnd: z.string().regex(/^\d{2}:\d{2}$/).default("21:00"),
  enabled: z.boolean().default(true)
});

export const updateIngestConfigRequestSchema = z.object({
  sourceType: z.enum(SOURCE_TYPES).optional(),
  maxPacketsPerDay: z.number().int().min(1).max(1000).optional(),
  metadata: z.record(z.unknown()).optional(),
  tweetTypeMix: z.record(z.enum(TWEET_TYPES), z.number().int().min(0).max(100)).optional(),
  scheduleWindowStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  scheduleWindowEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  enabled: z.boolean().optional()
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

export const updateStyleProfileRequestSchema = z.object({
  bannedPhrases: z.array(z.string().min(1)).optional(),
  description: z.string().max(1000).nullable().optional(),
  examplePosts: z.array(z.string().min(1)).optional(),
  name: z.string().min(1).max(120).optional(),
  rules: z.record(z.unknown()).optional(),
  tone: z.string().max(240).nullable().optional()
});

export const selectDraftCandidateRequestSchema = z.object({
  candidateId: idSchema,
  editedText: z.string().min(1).max(X_FREE_POST_CHARACTER_LIMIT).optional()
});

export const approveDraftRequestSchema = z.object({
  editedText: z.string().min(1).max(X_FREE_POST_CHARACTER_LIMIT),
  mode: z.enum(POSTING_MODES).optional(),
  scheduledFor: isoTimestampSchema.nullable().optional()
});

export const prepareJobRequestSchema = z.object({
  jobId: idSchema
});

export type Account = z.infer<typeof accountSchema>;
export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;
export type StyleProfile = z.infer<typeof styleProfileSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type DraftCandidate = z.infer<typeof draftCandidateSchema>;
export type PostJob = z.infer<typeof postJobSchema>;
export type PostAttempt = z.infer<typeof postAttemptSchema>;
export type PostHistory = z.infer<typeof postHistorySchema>;
export type SourcePacket = z.infer<typeof sourcePacketSchema>;
export type CreateDraftRequest = z.infer<typeof createDraftRequestSchema>;
export type CreateDraftBatchRequest = z.infer<typeof createDraftBatchRequestSchema>;
export type CreateSourcePacketRequest = z.infer<typeof createSourcePacketRequestSchema>;
export type UpdateGenerationConfigRequest = z.infer<typeof updateGenerationConfigRequestSchema>;
export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;
export type UpdateStyleProfileRequest = z.infer<typeof updateStyleProfileRequestSchema>;
export type SelectDraftCandidateRequest = z.infer<typeof selectDraftCandidateRequestSchema>;
export type ApproveDraftRequest = z.infer<typeof approveDraftRequestSchema>;
export type PrepareJobRequest = z.infer<typeof prepareJobRequestSchema>;
export type IngestConfig = z.infer<typeof ingestConfigSchema>;
export type CreateIngestConfigRequest = z.infer<typeof createIngestConfigRequestSchema>;
export type UpdateIngestConfigRequest = z.infer<typeof updateIngestConfigRequestSchema>;

export type PostHistoryIssueType =
  | "duplicate_text"
  | "generic_phrasing"
  | "missing_link"
  | "repeated_topic"
  | "weak_source_attribution";

export interface PostHistoryIssue {
  detail: string;
  historyIds: string[];
  severity: "low" | "medium" | "high";
  type: PostHistoryIssueType;
}

export interface PostHistoryAnalysis {
  generatedAt: string;
  issues: PostHistoryIssue[];
  postCount: number;
  since: string;
  summary: Record<PostHistoryIssueType, number>;
}

const HISTORY_GENERIC_PATTERNS = [
  /\bai is changing\b/i,
  /\bgame changer\b/i,
  /\bhere'?s why\b/i,
  /\bin today'?s (fast-paced )?world\b/i,
  /\bthis changes everything\b/i,
  /\bunlock\b/i,
  /\bworth paying attention\b/i
];

const HISTORY_TOPIC_STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "because",
  "being",
  "build",
  "builder",
  "builders",
  "change",
  "changing",
  "could",
  "from",
  "here",
  "into",
  "more",
  "news",
  "people",
  "post",
  "really",
  "should",
  "that",
  "their",
  "there",
  "these",
  "thing",
  "this",
  "today",
  "using",
  "what",
  "when",
  "where",
  "with",
  "world",
  "would"
]);

function analysisSummary() {
  return {
    duplicate_text: 0,
    generic_phrasing: 0,
    missing_link: 0,
    repeated_topic: 0,
    weak_source_attribution: 0
  };
}

function normalizedHistoryText(text: string) {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function historyTopicWords(text: string) {
  return new Set(
    normalizedHistoryText(text)
      .split(" ")
      .filter((word) => word.length >= 4 && !HISTORY_TOPIC_STOPWORDS.has(word))
      .slice(0, 24)
  );
}

function setOverlap(first: Set<string>, second: Set<string>) {
  let count = 0;
  for (const value of first) {
    if (second.has(value)) count += 1;
  }
  return count;
}

function sourceHost(url: string | null) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function containsUrl(text: string) {
  return /https?:\/\/\S+/i.test(text);
}

function sourceNeedsLink(item: PostHistory) {
  return item.sourceUrl && (item.tweetType === "article_summary" || item.tweetType === "hiring" || item.sourceType === "job");
}

export function analyzePostHistory(
  history: PostHistory[],
  options: { accountId?: string; now?: Date; sinceHours?: number } = {}
): PostHistoryAnalysis {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - (options.sinceHours ?? 24) * 60 * 60 * 1000).toISOString();
  const recent = history
    .filter((item) => (!options.accountId || item.accountId === options.accountId) && item.postedAt >= since)
    .sort((a, b) => a.postedAt.localeCompare(b.postedAt));
  const summary = analysisSummary();
  const issues: PostHistoryIssue[] = [];

  const byText = new Map<string, PostHistory[]>();
  for (const item of recent) {
    const normalized = normalizedHistoryText(item.postedText);
    byText.set(normalized, [...(byText.get(normalized) ?? []), item]);
  }
  for (const items of byText.values()) {
    if (items.length < 2) continue;
    summary.duplicate_text += 1;
    issues.push({
      detail: `Exact duplicate post text appeared ${items.length} times.`,
      historyIds: items.map((item) => item.id),
      severity: "high",
      type: "duplicate_text"
    });
  }

  for (const item of recent) {
    const matchedGeneric = HISTORY_GENERIC_PATTERNS.find((pattern) => pattern.test(item.postedText));
    if (matchedGeneric) {
      summary.generic_phrasing += 1;
      issues.push({
        detail: `Generic phrase matched ${String(matchedGeneric)}.`,
        historyIds: [item.id],
        severity: "medium",
        type: "generic_phrasing"
      });
    }

    if (sourceNeedsLink(item) && !containsUrl(item.postedText)) {
      summary.missing_link += 1;
      issues.push({
        detail: `Source-backed ${item.tweetType ?? item.sourceType} post omitted source URL ${item.sourceUrl}.`,
        historyIds: [item.id],
        severity: "medium",
        type: "missing_link"
      });
    }

    if ((item.sourcePacketId || item.sourceType) && !item.sourceTitle && !item.sourceUrl) {
      summary.weak_source_attribution += 1;
      issues.push({
        detail: "Source-backed post has no source title or source URL in history metadata.",
        historyIds: [item.id],
        severity: "medium",
        type: "weak_source_attribution"
      });
    } else if (item.sourceUrl && !containsUrl(item.postedText)) {
      const host = sourceHost(item.sourceUrl);
      const titleWords = item.sourceTitle ? historyTopicWords(item.sourceTitle) : new Set<string>();
      const postWords = historyTopicWords(item.postedText);
      if (host && titleWords.size > 0 && setOverlap(titleWords, postWords) === 0) {
        summary.weak_source_attribution += 1;
        issues.push({
          detail: `Post does not include link or recognizable source title terms for ${host}.`,
          historyIds: [item.id],
          severity: "low",
          type: "weak_source_attribution"
        });
      }
    }
  }

  for (let index = 0; index < recent.length; index += 1) {
    const item = recent[index]!;
    const currentWords = historyTopicWords(`${item.sourceTitle ?? ""} ${item.postedText}`);
    if (currentWords.size < 3) continue;
    for (const other of recent.slice(index + 1)) {
      const otherWords = historyTopicWords(`${other.sourceTitle ?? ""} ${other.postedText}`);
      const overlap = setOverlap(currentWords, otherWords);
      if (overlap < 4) continue;
      summary.repeated_topic += 1;
      issues.push({
        detail: `Topic overlap detected across recent posts (${overlap} shared terms).`,
        historyIds: [item.id, other.id],
        severity: "low",
        type: "repeated_topic"
      });
      break;
    }
  }

  return {
    generatedAt: now.toISOString(),
    issues,
    postCount: recent.length,
    since,
    summary
  };
}

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
export { nextAutopostScheduledFor } from "./spacing.js";
export type { NextAutopostInput, NextAutopostResult } from "./spacing.js";
export { resolveDataRoot, dataPath, profilesPath } from "./paths.js";
export const AI_SLOP_PHRASES = [
  "let's dive in",
  "let us dive in",
  "dive in",
  "delve",
  "delve into",
  "tapestry",
  "it's important to note",
  "in conclusion",
  "in today's",
  "in this day and age",
  "embark",
  "navigate the landscape",
  "navigate the complexities",
  "navigate the world",
  "game-changer",
  "game changer",
  "unlock the power",
  "unlock your",
  "robust solution",
  "leverage",
  "leverages",
  "synergy",
  "synergies",
  "cutting-edge",
  "cutting edge",
  "revolutionize",
  "revolutionary",
  "streamline",
  "streamlines",
  "holistic",
  "paradigm",
  "paradigm shift",
  "unleash the power",
  "unleash",
  "world-class",
  "world class",
  "seamless",
  "seamlessly",
  "elevate your",
  "empower",
  "harness the power",
  "harness the",
  "foster",
  "propel",
  "redefine",
  "in essence",
  "firstly",
  "secondly",
  "thirdly",
  "lastly",
  "moving forward",
  "at the end of the day",
  "when it comes to",
  "in the realm of",
  "in the world of",
  "a myriad of",
  "myriad of",
  "plethora of",
  "in this article",
  "this article will",
  "this guide will",
  "hope this helps",
  "as an ai",
  "as a language model",
  "as a large language model",
  "i cannot",
  "i'm sorry",
  "i am sorry",
  "i don't have",
  "feel free to",
  "don't hesitate to",
  "in summary",
  "to summarize",
  "ultimately",
  "ensure",
  "in order to",
  "in order for"
] as const;
export type AiSlopPhrase = (typeof AI_SLOP_PHRASES)[number];
