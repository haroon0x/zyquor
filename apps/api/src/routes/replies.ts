import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertDedicatedProfileDir } from "@zyquor/accounts";
import { parseReplyTargetUrl, type ReplyTarget } from "@zyquor/core";
import { accountGenerationContext, normalizeTweetType, analyzePostFeatures } from "@zyquor/automation";
import {
  isInterrogationDodgeReply,
  passesTweetQualityFloor,
  REPLY_DODGE_REASON
} from "@zyquor/generation";
import {
  renderGoldfishMemory,
  type GoldfishContextBundle,
  type GoldfishContextInput
} from "@zyquor/adapters";
import type { DraftGenerationProvider } from "@zyquor/generation";
import type { AppDeps } from "../deps.js";
import type { ZyquorRepository } from "@zyquor/storage";
import { HttpError } from "../lib/errors.js";
import { resolveProfileDir } from "../lib/paths.js";
import { tracePostProcessTweetText } from "../lib/post-process.js";

type DraftUpdated = Awaited<ReturnType<ZyquorRepository["saveDraftCandidates"]>>;

interface MentionTweet {
  id: string;
  authorHandle: string;
  authorName: string;
  text: string;
  url: string;
  publishedAt: string | null;
  isRetweet?: boolean;
  isPromoted?: boolean;
  hasLink?: boolean;
}

const fromUrlSchema = z.object({
  accountId: z.string().optional().default("account_personal"),
  url: z.string().url(),
  useMemory: z.boolean().optional(),
  // Best-of-N candidates (1..50): the route drafts N candidates in one call so
  // the reviewer can pick from a wide pool instead of regenerating blind. The
  // generation layer fills the pool with bounded top-up passes.
  count: z.number().int().min(1).max(50).optional()
});

const mentionsQuerySchema = z.object({
  accountId: z.string().optional(),
  maxTweets: z.coerce.number().int().min(1).max(50).optional().default(30)
});

const mentionsDraftSchema = z.object({
  accountId: z.string().optional().default("account_personal"),
  mentions: z.array(z.object({ url: z.string().url() })).min(1).max(10),
  useMemory: z.boolean().optional()
});

const mentionsScanDraftSchema = z.object({
  accountId: z.string().optional().default("account_personal"),
  maxTweets: z.number().int().min(1).max(50).optional().default(30),
  useMemory: z.boolean().optional()
});

const mentionsScanAutoApproveSchema = z.object({
  accountId: z.string().optional().default("account_personal"),
  maxTweets: z.number().int().min(1).max(50).optional().default(30)
});

const MENTION_FRESH_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_SCANNED_MENTIONS = 50;
const MAX_DRAFT_MENTIONS_PER_CALL = 10;
const MAX_REPLY_SOURCE = 2_500;
const MEMORY_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_AUTO_APPROVE_DAILY_CAP = 3;
const MAX_AUTO_APPROVE_DAILY_CAP = 50;

// Stage 2 of the mentions autonomy ladder: a fixed daily ceiling on
// machine-approved replies. The lane only ever works through the review
// pipeline; the cap counts approvals, not posts. A cap of 0 disables
// approvals entirely (drafts still queue for human review).
function mentionsAutoApproveDailyCap(): number {
  const configured = process.env.ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP?.trim();
  const value = configured ? Number(configured) : Number.NaN;
  return Number.isFinite(value)
    ? Math.min(MAX_AUTO_APPROVE_DAILY_CAP, Math.max(0, Math.floor(value)))
    : DEFAULT_AUTO_APPROVE_DAILY_CAP;
}

function isSameLocalDay(iso: string | null | undefined, reference: Date): boolean {
  if (!iso) return false;
  const value = Date.parse(iso);
  if (!Number.isFinite(value)) return false;
  const other = new Date(value);
  return (
    other.getFullYear() === reference.getFullYear() &&
    other.getMonth() === reference.getMonth() &&
    other.getDate() === reference.getDate()
  );
}

function isAdPost(tweet: { isPromoted?: boolean; hasLink?: boolean }): boolean {
  return Boolean(tweet.isPromoted) || Boolean(tweet.hasLink);
}

function targetFromTweet(tweet: MentionTweet): ReplyTarget {
  return {
    tweetId: tweet.id,
    authorHandle: tweet.authorHandle,
    url: tweet.url,
    authorName: tweet.authorName,
    text: tweet.text
  };
}

function truncatedReplySource(replyTo: ReplyTarget): ReplyTarget {
  if (replyTo.text && replyTo.text.length > MAX_REPLY_SOURCE) {
    return { ...replyTo, text: `${replyTo.text.slice(0, MAX_REPLY_SOURCE).trimEnd()}…` };
  }
  return replyTo;
}

function statusKey(url: string): string {
  return url
    .replace(/\/$/, "")
    .replace(/^https:\/\/twitter\.com\//i, "https://x.com/")
    .replace(/^http:/i, "https:");
}

async function accountProfile(
  repository: Promise<ZyquorRepository>,
  accountId: string
): Promise<{ accountId: string; profileDir: string; styleProfileId: string | null }> {
  const repo = await repository;
  const account = await repo.getAccount(accountId);
  if (!account) {
    throw new HttpError(404, "Account not found");
  }
  assertDedicatedProfileDir(account.profileDir);
  return {
    accountId: account.id,
    profileDir: resolveProfileDir(account.profileDir),
    styleProfileId: account.styleProfileId ?? null
  };
}

// The style rule (rules.replyMemory) is the per-account default; an explicit
// useMemory in the request body always wins.
async function replyMemoryDefault(
  repository: ZyquorRepository,
  styleProfileId: string | null
): Promise<boolean> {
  if (!styleProfileId) {
    return true;
  }
  const profile = await repository.getStyleProfile(styleProfileId);
  const rules = (profile?.rules ?? {}) as Record<string, unknown>;
  return rules.replyMemory !== false;
}

async function withMemoryTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

interface ReplyMemorySelection {
  used: boolean;
  reason?: "disabled" | "empty" | "unavailable";
  terms?: string[];
  wiki?: GoldfishContextBundle["wiki"];
  memories?: GoldfishContextBundle["memories"];
}

// Memory never fails a request: disabled/unavailable/empty all degrade to
// "generate without memory". maxMemories (when given) caps the activity
// excerpts fetched; 0 fetches wiki facts only, which the auto-approve lane
// uses so email/meeting activity never enters unreviewed text.
async function resolveReplyMemory(
  deps: AppDeps,
  input: GoldfishContextInput,
  useMemory: boolean,
  maxMemories?: number
): Promise<ReplyMemorySelection> {
  if (!useMemory) {
    return { used: false, reason: "disabled" };
  }
  const bundle = await withMemoryTimeout(
    deps.goldfishReplyContext({
      ...input,
      ...(maxMemories !== undefined ? { maxMemories } : {})
    }),
    MEMORY_FETCH_TIMEOUT_MS,
    null
  );
  if (!bundle) {
    return { used: false, reason: "unavailable" };
  }
  if (bundle.wiki.length === 0 && bundle.memories.length === 0) {
    return { used: false, reason: "empty" };
  }
  return { used: true, terms: bundle.terms, wiki: bundle.wiki, memories: bundle.memories };
}

function memoryMetadata(selection: ReplyMemorySelection): Record<string, unknown> | undefined {
  const wikiTitles = (selection.wiki ?? []).map((item) => item.title);
  const memoryTitles = (selection.memories ?? []).map((item) => item.title);
  if (!selection.used || (wikiTitles.length === 0 && memoryTitles.length === 0)) {
    return undefined;
  }
  return {
    terms: selection.terms ?? [],
    wikiTitles,
    memories: memoryTitles,
    wikiCount: wikiTitles.length,
    memoryCount: memoryTitles.length
  };
}

function memoryResponse(selection: ReplyMemorySelection) {
  if (selection.used) {
    return {
      used: true,
      terms: selection.terms ?? [],
      wikiCount: (selection.wiki ?? []).length,
      memoryCount: (selection.memories ?? []).length
    };
  }
  return { used: false, reason: selection.reason ?? "unavailable" };
}

async function mintReplyMetadata(
  deps: AppDeps,
  repository: ZyquorRepository,
  styleProfileId: string | null,
  replyTo: ReplyTarget,
  baseMetadata: Record<string, unknown>,
  useMemory: boolean | undefined,
  maxMemories?: number
): Promise<{ metadata: Record<string, unknown>; memory: ReplyMemorySelection }> {
  const useMemoryEffective = useMemory ?? (await replyMemoryDefault(repository, styleProfileId));
  const memory = await resolveReplyMemory(
    deps,
    {
      authorHandle: replyTo.authorHandle,
      authorName: replyTo.authorName,
      tweetText: replyTo.text
    },
    useMemoryEffective,
    maxMemories
  );
  return {
    metadata: {
      ...baseMetadata,
      ...(memoryMetadata(memory) ? { memory: memoryMetadata(memory) } : {})
    },
    memory
  };
}

async function createReplyDraft(
  deps: AppDeps,
  repository: ZyquorRepository,
  accountId: string,
  replyTo: ReplyTarget,
  baseMetadata: Record<string, unknown>,
  useMemory: boolean | undefined,
  styleProfileId: string | null,
  maxMemories?: number,
  otherReplies?: string[]
): Promise<{ updated: DraftUpdated; memory: ReplyMemorySelection }> {
  const { metadata, memory } = await mintReplyMetadata(
    deps,
    repository,
    styleProfileId,
    replyTo,
    baseMetadata,
    useMemory,
    maxMemories
  );
  const created = await repository.createDraft({
    accountId,
    sourceInput: replyTo.text ?? replyTo.url,
    replyTo,
    metadata
  });
  const context = await accountGenerationContext(repository, accountId);
  // Best-of-N: the metadata.count set by the caller (1 for the auto-approve
  // lane, 1..3 for from-url) drives how many candidates get generated here.
  const candidateCount = Math.max(1, Math.min(3, Number(baseMetadata.count) || 1));
  const generationInput = {
    idea: created.draft.sourceInput,
    count: candidateCount,
    preserveCase: true,
    ...context,
    tweetType: normalizeTweetType("reply"),
    replyContext: {
      authorHandle: replyTo.authorHandle,
      url: replyTo.url,
      ...(replyTo.authorName ? { authorName: replyTo.authorName } : {}),
      ...(replyTo.text ? { text: replyTo.text } : {}),
      ...(otherReplies && otherReplies.length > 0 ? { otherReplies } : {})
    },
    ...(memory.used
      ? {
          memoryContext: renderGoldfishMemory({
            terms: memory.terms ?? [],
            wiki: memory.wiki ?? [],
            memories: memory.memories ?? []
          })
        }
      : {})
  };
  const candidates = await deps.generationProvider.generateDraftCandidates(generationInput);
  const updated = await repository.saveDraftCandidates(
    created.draft.id,
    candidates.map((candidate) => ({ ...candidate, text: candidate.text }))
  );
  return { updated, memory };
}

function draftedUrlSet(drafts: Array<{ replyTo?: ReplyTarget | null }>): Set<string> {
  const urls = new Set<string>();
  for (const draft of drafts) {
    if (draft.replyTo?.url) {
      urls.add(statusKey(draft.replyTo.url));
    }
  }
  return urls;
}

async function fetchFreshMentions(
  deps: AppDeps,
  profileDir: string,
  maxTweets: number
): Promise<{ mentions: MentionTweet[]; adsSkipped: number; scanned: number }> {
  const result = await deps.browser.fetchXMentions({
    profileDir,
    maxTweets: Math.min(maxTweets, MAX_SCANNED_MENTIONS),
    scrolls: 4
  });
  const cutoff = Date.now() - MENTION_FRESH_WINDOW_MS;
  const seen = new Set<string>();
  const mentions: MentionTweet[] = [];
  let adsSkipped = 0;
  for (const tweet of result.tweets) {
    if (tweet.isPromoted) {
      adsSkipped += 1;
      continue;
    }
    if (seen.has(tweet.url)) continue;
    seen.add(tweet.url);
    // A mention without a parseable timestamp counts as fresh: treat it like
    // the poll script did (published now), never like ancient history.
    const publishedAt = tweet.publishedAt ? Date.parse(tweet.publishedAt) : Date.now();
    if (!Number.isFinite(publishedAt) || publishedAt < cutoff) continue;
    mentions.push({
      id: tweet.id,
      authorHandle: tweet.authorHandle,
      authorName: tweet.authorName,
      text: tweet.text,
      url: tweet.url,
      publishedAt: tweet.publishedAt,
      isRetweet: tweet.isRetweet,
      isPromoted: tweet.isPromoted,
      hasLink: tweet.hasLink
    });
  }
  return { mentions, adsSkipped, scanned: result.tweets.length };
}

export function registerRepliesRoutes(app: FastifyInstance, deps: AppDeps): void {
  const accountIdFrom = (value: unknown) => (typeof value === "string" && value.length ? value : "account_personal");

  app.get("/replies/feed", async (request, reply) => {
    const accountId = accountIdFrom((request.query as { accountId?: unknown }).accountId);
    const { profileDir } = await accountProfile(deps.repository, accountId);
    try {
      const result = await deps.browser.fetchXHomeFeed({
        profileDir,
        maxTweets: 30,
        minTweets: 5,
        scrolls: 4
      });
      const seen = new Set<string>();
      const accounts = new Map<string, { authorHandle: string; authorName: string }>();
      let adsSkipped = 0;
      const tweets = result.tweets.filter((tweet) => {
        if (isAdPost(tweet)) {
          adsSkipped += 1;
          return false;
        }
        if (seen.has(tweet.url)) return false;
        seen.add(tweet.url);
        const key = `@${tweet.authorHandle}`;
        if (!accounts.has(key)) {
          accounts.set(key, { authorHandle: tweet.authorHandle, authorName: tweet.authorName });
        }
        return true;
      });
      return { url: result.url, tweets, accounts: Array.from(accounts.values()), adsSkipped };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown feed scan error";
      return reply.code(502).send({ error: message });
    }
  });

  app.post("/replies/from-url", async (request, reply) => {
    const input = fromUrlSchema.parse(request.body);
    if (!parseReplyTargetUrl(input.url)) {
      return reply.code(400).send({ error: "url must be a valid x.com or twitter.com post URL" });
    }
    const { accountId, profileDir, styleProfileId } = await accountProfile(deps.repository, input.accountId);
    let fetched;
    try {
      fetched = await deps.browser.fetchTweet({ profileDir, url: input.url, maxReplies: 6 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown tweet fetch error";
      return reply.code(502).send({ error: message });
    }
    let replyTo = targetFromTweet(fetched.tweet);
    if (isAdPost(fetched.tweet)) {
      return reply
        .code(400)
        .send({ error: "That post looks like an advertisement (it is tagged as promoted or contains a link). Nothing to reply to." });
    }
    replyTo = truncatedReplySource(replyTo);
    // The conversation as the human would see it: replies already posted under
    // the target. Context is bounded on purpose: 6 replies, 220 chars each,
    // whitespace collapsed, link-only spam and duplicates dropped, so the
    // prompt reads like a skim of the thread instead of the whole comment dump.
    const otherReplies: string[] = [];
    const seenReplyText = new Set<string>();
    for (const reply of fetched.replies ?? []) {
      if (otherReplies.length >= 6) break;
      if (reply.isPromoted) continue;
      const text = (reply.text ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
      if (text.length < 8) continue;
      // A bare link or "thanks + link" spam adds nothing to a reply.
      if (/https?:\/\//.test(text) && text.length < 80) continue;
      if (seenReplyText.has(text)) continue;
      seenReplyText.add(text);
      otherReplies.push(text);
    }

    const repository = await deps.repository;
    if (replyTo.url && (await repository.hasPostHistorySourceUrl(accountId, replyTo.url))) {
      return reply.code(409).send({ error: "This tweet was already posted to in the past" });
    }

    const { updated, memory } = await createReplyDraft(
      deps,
      repository,
      accountId,
      replyTo,
      { yolo: false, autopost: false, count: input.count ?? 1, tweetType: "reply", sourceReplies: otherReplies.length },
      input.useMemory,
      styleProfileId,
      undefined,
      otherReplies.length > 0 ? otherReplies : undefined
    );

    return reply.code(201).send({
      draft: updated.draft,
      candidates: updated.candidates,
      replyTo,
      ...(otherReplies.length > 0 ? { otherReplies } : {}),
      memory: memoryResponse(memory)
    });
  });

  app.get("/replies/mentions", async (request, reply) => {
    const query = mentionsQuerySchema.parse(request.query);
    const { accountId, profileDir } = await accountProfile(deps.repository, accountIdFrom(query.accountId));
    let scan: { mentions: MentionTweet[]; adsSkipped: number; scanned: number };
    try {
      scan = await fetchFreshMentions(deps, profileDir, query.maxTweets);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown mentions scan error";
      return reply.code(502).send({ error: message });
    }

    const repository = await deps.repository;
    const drafted = draftedUrlSet(await repository.listDrafts(accountId));
    const annotated: Array<MentionTweet & { drafted: boolean; posted: boolean }> = [];
    for (const item of scan.mentions) {
      // Posted wins over drafted so the UI shows a single actionable pill.
      const posted = await repository.hasPostHistorySourceUrl(accountId, item.url);
      annotated.push({
        ...item,
        drafted: !posted && drafted.has(statusKey(item.url)),
        posted
      });
    }
    return { mentions: annotated, scanned: scan.scanned, adsSkipped: scan.adsSkipped };
  });

  app.post("/replies/mentions/draft", async (request, reply) => {
    const input = mentionsDraftSchema.parse(request.body);
    const { accountId, profileDir, styleProfileId } = await accountProfile(deps.repository, input.accountId);
    const repository = await deps.repository;

    const byUrl = new Map<string, MentionTweet>();
    try {
      const scan = await deps.browser.fetchXMentions({ profileDir, maxTweets: MAX_SCANNED_MENTIONS, scrolls: 4 });
      for (const tweet of scan.tweets) {
        byUrl.set(statusKey(tweet.url), tweet);
      }
    } catch {
      // The scan is an optimization: without it each requested tweet is
      // fetched individually below (slower, same result).
    }

    const drafted = draftedUrlSet(await repository.listDrafts(accountId));
    const created: Array<{ draft: DraftUpdated["draft"]; candidates: DraftUpdated["candidates"] }> = [];
    const skipped: Array<{ url: string; reason: string }> = [];

    for (const mention of input.mentions) {
      const url = mention.url;
      const key = statusKey(url);
      // Posted takes precedence over drafted: replying to it is a complete no-op.
      if (await repository.hasPostHistorySourceUrl(accountId, key)) {
        skipped.push({ url, reason: "posted" });
        continue;
      }
      if (drafted.has(key)) {
        skipped.push({ url, reason: "drafted" });
        continue;
      }
      let tweet = byUrl.get(key) ?? null;
      if (!tweet) {
        if (!parseReplyTargetUrl(url)) {
          skipped.push({ url, reason: "unavailable" });
          continue;
        }
        try {
          const fetched = await deps.browser.fetchTweet({ profileDir, url });
          tweet = fetched.tweet;
        } catch {
          skipped.push({ url, reason: "unavailable" });
          continue;
        }
      }
      if (tweet.isPromoted) {
        skipped.push({ url, reason: "promoted" });
        continue;
      }
      const replyTo = truncatedReplySource(targetFromTweet(tweet));
      const { updated } = await createReplyDraft(
        deps,
        repository,
        accountId,
        replyTo,
        { yolo: false, autopost: false, count: 1, tweetType: "reply", origin: "mention-scan", authorHandle: replyTo.authorHandle },
        input.useMemory,
        styleProfileId
      );
      created.push({ draft: updated.draft, candidates: updated.candidates });
      drafted.add(key);
    }

    return { created, skipped };
  });

  app.post("/replies/mentions/scan-and-draft", async (request, reply) => {
    const input = mentionsScanDraftSchema.parse(request.body);
    const { accountId, profileDir, styleProfileId } = await accountProfile(deps.repository, input.accountId);
    const repository = await deps.repository;

    let scan: { mentions: MentionTweet[]; adsSkipped: number; scanned: number };
    try {
      scan = await fetchFreshMentions(deps, profileDir, input.maxTweets ?? 30);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown mentions scan error";
      return reply.code(502).send({ error: message });
    }

    const drafted = draftedUrlSet(await repository.listDrafts(accountId));
    const created: Array<{ draft: DraftUpdated["draft"]; candidates: DraftUpdated["candidates"] }> = [];
    const skipped: Array<{ url: string; reason: string }> = [];

    for (const item of scan.mentions) {
      if (created.length >= MAX_DRAFT_MENTIONS_PER_CALL) {
        break;
      }
      const key = statusKey(item.url);
      // Posted takes precedence over drafted: replying to it is a complete no-op.
      if (await repository.hasPostHistorySourceUrl(accountId, key)) {
        skipped.push({ url: item.url, reason: "posted" });
        continue;
      }
      if (drafted.has(key)) {
        skipped.push({ url: item.url, reason: "drafted" });
        continue;
      }
      const replyTo = truncatedReplySource(targetFromTweet(item));
      const { updated } = await createReplyDraft(
        deps,
        repository,
        accountId,
        replyTo,
        { yolo: false, autopost: false, count: 1, tweetType: "reply", origin: "mention-scan", authorHandle: replyTo.authorHandle },
        input.useMemory,
        styleProfileId
      );
      created.push({ draft: updated.draft, candidates: updated.candidates });
      drafted.add(key);
    }

    return { scanned: scan.scanned, created, skipped, adsSkipped: scan.adsSkipped };
  });

  // Stage 2 autonomy lane: scan fresh mentions, draft with wiki-only memory,
  // and auto-approve only the top candidate when it clears the shared quality
  // floor, strictly within a daily cap. Approval mirrors the human approve
  // route (post-processing, features, approveDraft), so the result is a
  // review_required post job queued like any other; nothing here posts and
  // every non-approved draft stays in the review queue untouched.
  app.post("/replies/mentions/scan-and-auto-approve", async (request, reply) => {
    const input = mentionsScanAutoApproveSchema.parse(request.body);
    const { accountId, profileDir, styleProfileId } = await accountProfile(deps.repository, input.accountId);
    const repository = await deps.repository;

    let scan: { mentions: MentionTweet[]; adsSkipped: number; scanned: number };
    try {
      scan = await fetchFreshMentions(deps, profileDir, input.maxTweets ?? 30);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown mentions scan error";
      return reply.code(502).send({ error: message });
    }

    const dailyCap = mentionsAutoApproveDailyCap();
    const drafts = await repository.listDrafts(accountId);
    const autoApprovedDraftIds = new Set(
      drafts.filter((draft) => draft.metadata.autoApproved === true).map((draft) => draft.id)
    );
    const jobs = await repository.listJobs(accountId);
    const now = new Date();
    const approvedToday = new Set(
      jobs
        .filter((job) => autoApprovedDraftIds.has(job.draftId) && isSameLocalDay(job.approvedAt, now))
        .map((job) => job.draftId)
    ).size;
    let remainingToday = Math.max(0, dailyCap - approvedToday);

    const drafted = draftedUrlSet(drafts);
    const created: Array<{ draft: DraftUpdated["draft"]; candidates: DraftUpdated["candidates"] }> = [];
    const approved: Array<{ url: string; draftId: string; text: string }> = [];
    const held: Array<{ url: string; reason: string }> = [];
    const skipped: Array<{ url: string; reason: string }> = [];

    for (const item of scan.mentions) {
      const key = statusKey(item.url);
      // Posted takes precedence over drafted: replying to it is a complete no-op.
      if (await repository.hasPostHistorySourceUrl(accountId, key)) {
        skipped.push({ url: item.url, reason: "posted" });
        continue;
      }
      if (drafted.has(key)) {
        skipped.push({ url: item.url, reason: "drafted" });
        continue;
      }
      const replyTo = truncatedReplySource(targetFromTweet(item));
      let updated: DraftUpdated;
      try {
        // Wiki-only memory: maxMemories 0 means activity excerpts (email,
        // meetings) can never reach text approved without a human.
        ({ updated } = await createReplyDraft(
          deps,
          repository,
          accountId,
          replyTo,
          { yolo: false, autopost: false, count: 1, tweetType: "reply", origin: "mention-scan", authorHandle: replyTo.authorHandle },
          true,
          styleProfileId,
          0
        ));
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        held.push({ url: item.url, reason: `draft_failed: ${message}` });
        continue;
      }
      created.push({ draft: updated.draft, candidates: updated.candidates });
      drafted.add(key);

      const selected = updated.candidates.find((candidate) => candidate.selected) ?? null;
      if (!selected) {
        held.push({ url: item.url, reason: "no_candidates" });
        continue;
      }
      const preserveCase = selected.score.provider === deps.generationProvider.name;
      // Same shaping as the human approve step, with a lane-specific trace label.
      const approvedText = tracePostProcessTweetText("mentions-auto-approve", selected.text, preserveCase);
      if (isInterrogationDodgeReply(approvedText)) {
        held.push({ url: item.url, reason: REPLY_DODGE_REASON });
        continue;
      }
      if (!passesTweetQualityFloor(approvedText)) {
        held.push({ url: item.url, reason: "quality_below_floor" });
        continue;
      }
      // X rejects post-length overruns at compose time; a lane approval must
      // never create a job that fails on typing. Keep margin from the
      // hard 280: no reply lane text ships above 275 raw characters.
      if (approvedText.length > 275) {
        held.push({ url: item.url, reason: `too_long: ${approvedText.length} chars` });
        continue;
      }
      if (remainingToday <= 0) {
        held.push({ url: item.url, reason: "daily_cap_reached" });
        continue;
      }
      try {
        await repository.updateDraftMetadata(updated.draft.id, {
          ...updated.draft.metadata,
          features: analyzePostFeatures(approvedText),
          autoApproved: true
        });
        const result = await repository.approveDraft({
          draftId: updated.draft.id,
          editedText: approvedText,
          mode: "review_required",
          ...(updated.draft.replyTo ? { replyTo: updated.draft.replyTo } : {})
        });
        approved.push({ url: item.url, draftId: result.draft.id, text: result.draft.editedText ?? approvedText });
        remainingToday -= 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        held.push({ url: item.url, reason: `approve_failed: ${message}` });
      }
    }

    return {
      scanned: scan.scanned,
      created,
      approved,
      held,
      skipped,
      adsSkipped: scan.adsSkipped,
      dailyCap,
      remainingToday: Math.max(0, remainingToday)
    };
  });

  app.get("/replies/drafts", async (request, reply) => {
    const accountId = accountIdFrom((request.query as { accountId?: unknown }).accountId);
    const repository = await deps.repository;
    const drafts = (await repository.listDrafts(accountId)).filter((draft) => Boolean(draft.replyTo));
    return { drafts };
  });
}
