import type {
  Account,
  Draft,
  DraftCandidate,
  PostAttempt,
  PostHistory,
  PostJob,
  ReplyTarget,
  SourcePacket,
  StyleProfile,
  IngestConfig,
  SourceType,
  TweetType
} from "@zyquor/core";
import { parseReplyTargetUrl, replyTargetSchema } from "@zyquor/core";
import type { IngestRun } from "./types.js";

export function serializeReplyTarget(replyTo: ReplyTarget | undefined): string | null {
  return replyTo ? JSON.stringify(replyTargetSchema.parse(replyTo)) : null;
}

export function deserializeReplyTarget(value: unknown, legacyUrl?: unknown): ReplyTarget | undefined {
  if (value != null) {
    return replyTargetSchema.parse(JSON.parse(String(value)));
  }
  return typeof legacyUrl === "string" ? (parseReplyTargetUrl(legacyUrl) ?? undefined) : undefined;
}

export function toAccount(row: Record<string, unknown>): Account {
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

export function toDraft(row: Record<string, unknown>): Draft {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    sourceType: "text",
    sourceInput: String(row.source_input),
    generatedText: row.generated_text === null ? null : String(row.generated_text),
    editedText: row.edited_text === null ? null : String(row.edited_text),
    replyTo: deserializeReplyTarget(row.reply_to_json, row.reply_to_url),
    replyToUrl: row.reply_to_url == null ? null : String(row.reply_to_url),
    metadata: JSON.parse(String(row.metadata_json || "{}")) as Record<string, unknown>,
    status: row.status as Draft["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function toCandidate(row: Record<string, unknown>): DraftCandidate {
  return {
    id: String(row.id),
    draftId: String(row.draft_id),
    text: String(row.text),
    score: JSON.parse(String(row.score_json)) as Record<string, unknown>,
    selected: Boolean(row.selected),
    createdAt: String(row.created_at)
  };
}

export function toJob(row: Record<string, unknown>): PostJob {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    draftId: String(row.draft_id),
    status: row.status as PostJob["status"],
    mode: row.mode as PostJob["mode"],
    scheduledFor: row.scheduled_for === null ? null : String(row.scheduled_for),
    replyTo: deserializeReplyTarget(row.reply_to_json, row.reply_to_url),
    replyToUrl: row.reply_to_url == null ? null : String(row.reply_to_url),
    approvedAt: row.approved_at === null ? null : String(row.approved_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function toAttempt(row: Record<string, unknown>): PostAttempt {
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

export function toIngestRun(row: Record<string, unknown>): IngestRun {
  return {
    id: String(row.id),
    configId: String(row.config_id),
    accountId: String(row.account_id),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    status: row.status as IngestRun["status"],
    error: row.error === null ? null : String(row.error),
    packetsCreated: Number(row.packets_created)
  };
}

export function toPostHistory(row: Record<string, unknown>): PostHistory {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    draftId: String(row.draft_id),
    postedText: String(row.posted_text),
    postUrl: row.post_url === null ? null : String(row.post_url),
    sourcePacketId: row.source_packet_id == null ? null : String(row.source_packet_id),
    sourceType: row.source_type == null ? null : (row.source_type as PostHistory["sourceType"]),
    sourceTitle: row.source_title == null ? null : String(row.source_title),
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    tweetType: row.tweet_type == null ? null : (row.tweet_type as PostHistory["tweetType"]),
    metadata: JSON.parse(String(row.metadata_json || "{}")) as Record<string, unknown>,
    postedAt: String(row.posted_at)
  };
}

export function toStyleProfile(row: Record<string, unknown>): StyleProfile {
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

export function toSourcePacket(row: Record<string, unknown>): SourcePacket {
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

export function toIngestConfig(row: Record<string, unknown>): IngestConfig {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    sourceType: row.source_type as SourceType,
    maxPacketsPerDay: Number(row.max_packets_per_day),
    metadata: JSON.parse(String(row.metadata_json || "{}")) as Record<string, unknown>,
    tweetTypeMix: JSON.parse(String(row.tweet_type_mix_json)) as Record<string, number>,
    scheduleWindowStart: String(row.schedule_window_start),
    scheduleWindowEnd: String(row.schedule_window_end),
    enabled: Boolean(row.enabled),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}
