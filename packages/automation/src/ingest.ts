import type { SourceAdapter, SourceItem } from "@zyquor/adapters";
import type { DraftGenerationProvider } from "@zyquor/generation";
import type { ZyquorRepository } from "@zyquor/storage";
import { hasEnoughSourceContext, packetFieldsFromFeedDigest, packetFieldsFromItem } from "./context.js";
import { draftFromSourcePacket, TopicDraftExistsError } from "./draft.js";
import { isLowSignalSourceTitle } from "./quality.js";
import { sourcePerformanceByType, type SourcePerformance } from "./performance.js";
import { routeTweetType } from "./routing.js";
import { isSourceType, isWithinScheduleWindow } from "./selection.js";
import { hasTopicOverlap } from "./topic.js";

export interface IngestRunResult {
  configId: string;
  draftId: string;
  jobId: string | null;
  packetId: string;
  sourceType: string;
  url: string | null;
}

export interface IngestSkipSummary {
  blockedUrl: number;
  duplicatePacket: number;
  duplicatePostedUrl: number;
  hostCap: number;
  offTopic: number;
  packetCap: number;
  scheduleWindow: number;
  thinContext: number;
  topicOverlap: number;
  lowSignal: number;
}

function createSkipSummary(): IngestSkipSummary {
  return {
    blockedUrl: 0,
    duplicatePacket: 0,
    duplicatePostedUrl: 0,
    hostCap: 0,
    offTopic: 0,
    packetCap: 0,
    scheduleWindow: 0,
    thinContext: 0,
    topicOverlap: 0,
    lowSignal: 0
  };
}

export interface RunAutomaticIngestOptions {
  adapters: Map<string, SourceAdapter>;
  autoApproveEnabled?: boolean;
  generationProvider: DraftGenerationProvider;
  now?: Date;
  onProgress?: (progress: { errors: Array<{ configId: string; error: string }>; processed: number }) => void;
  repository: ZyquorRepository;
  shouldContinue?: () => boolean;
}

const CORE_AI_TERMS = [
  "ai", "a.i.", "artificial intelligence", "agi",
  "llm", "llms", "language model", "foundation model", "frontier model",
  "gpt", "chatgpt", "claude", "gemini", "llama", "mistral", "qwen", "deepseek", "grok",
  "openai", "anthropic", "huggingface", "hugging face", "ollama", "vllm",
  "agent", "agents", "agentic", "copilot", "cursor", "codex", "devin",
  "fine-tune", "fine-tuning", "finetune", "finetuning", "lora", "quantization", "quantized",
  "inference", "prompt", "prompting", "rag", "retrieval augmented", "embedding", "embeddings",
  "transformer", "attention", "context window", "token", "tokens", "tokenizer",
  "mcp", "model context protocol", "tool use", "function calling",
  "benchmark", "eval", "evals", "hallucination", "alignment", "rlhf",
  "diffusion", "multimodal", "vision model", "reasoning model", "chain of thought",
  "vector database", "sandbox", "harness", "vibe coding", "code generation",
  "machine learning", "deep learning", "neural network", "training run", "pretraining"
];

const SUPPORTING_TERMS = [
  "developer", "programming", "software", "open source", "framework", "sdk", "api",
  "startup", "funding", "launch", "release", "product", "shipped",
  "github", "repo", "library", "cli", "terminal", "ide", "editor",
  "database", "infrastructure", "latency", "throughput", "gpu", "nvidia", "compute"
];

const OFF_TOPIC_TERMS = [
  "nuclear", "reactor", "barge", "climate", "carbon", "emissions", "solar farm", "wind farm",
  "crypto", "bitcoin", "ethereum", "blockchain", "web3", "nft", "token sale",
  "gdp", "inflation", "interest rate", "federal reserve", "central bank", "jobs report",
  "unemployment", "stocks", "bonds", "yield", "tariff",
  "vaccine", "drug trial", "clinical trial", "biotech", "pharma",
  "rocket", "spacex", "satellite", "asteroid",
  "election", "senate", "congress", "parliament", "lawsuit filed",
  "dating app", "sports", "football", "basketball", "olympics"
];

function termPattern(term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
}

const CORE_PATTERNS = CORE_AI_TERMS.map(termPattern);
const SUPPORTING_PATTERNS = SUPPORTING_TERMS.map(termPattern);
const OFF_TOPIC_PATTERNS = OFF_TOPIC_TERMS.map(termPattern);

export function isOnTopicSourceItem(item: { content: string; title: string }) {
  const text = `${item.title} ${item.content}`;
  const hasCore = CORE_PATTERNS.some((pattern) => pattern.test(text));
  if (!hasCore && OFF_TOPIC_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return hasCore;
}

const BLOCKED_SOURCE_HOSTS = new Set([
  "book.stripe.com",
  "buy.stripe.com",
  "checkout.stripe.com",
  "pay.stripe.com",
  "gumroad.com"
]);
const DEFAULT_MAX_SAME_HOST_POSTS_PER_DAY = 100;
const DEFAULT_MAX_GITHUB_POSTS_PER_DAY = 100;
const MAX_SOURCE_AGE_MS = 48 * 60 * 60 * 1000;

function envPositiveInt(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Dead-source feedback, per x-algorithm engagement weights. A source whose posts
// consistently earn no engagement gets a fraction of its normal daily packet cap,
// so we stop drafting (and auto-posting) material that X's model ranks near zero.
// A minimum sample is required first: capping on one or two posts confuses
// "no distribution yet" with "dead source" and silently narrows the feed.
const DEAD_SOURCE_ENGAGEMENT_FLOOR = 0.5;
const DEAD_SOURCE_CAP_RATIO = 0.25;
const DEAD_SOURCE_MIN_SAMPLE = envPositiveInt("ZYQUOR_DEAD_SOURCE_MIN_SAMPLE", 5);

function configPerformanceKey(config: { sourceType: string }, performance: Map<string, SourcePerformance>) {
  const sourcePerformance = performance.get(config.sourceType);
  if (!sourcePerformance || sourcePerformance.posts < 1) return 0.25;
  return sourcePerformance.engagementPerPost;
}

function performanceAdjustedTarget(
  baseTarget: number,
  sourcePerformance: SourcePerformance | undefined
): { target: number; reason: string } {
  if (!sourcePerformance || sourcePerformance.posts < 1) {
    return { target: baseTarget, reason: "no-performance-data" };
  }
  if (sourcePerformance.posts < DEAD_SOURCE_MIN_SAMPLE) {
    return { target: baseTarget, reason: `insufficient-sample posts=${sourcePerformance.posts}` };
  }
  if (sourcePerformance.engagementPerPost < DEAD_SOURCE_ENGAGEMENT_FLOOR) {
    const reduced = Math.max(1, Math.floor(baseTarget * DEAD_SOURCE_CAP_RATIO));
    return {
      target: reduced,
      reason: `dead-source engagementPerPost=${sourcePerformance.engagementPerPost.toFixed(2)}`
    };
  }
  return { target: baseTarget, reason: `engagementPerPost=${sourcePerformance.engagementPerPost.toFixed(2)}` };
}

function sameHostPostCap(host: string) {
  if (host === "github.com") {
    return envPositiveInt("ZYQUOR_MAX_GITHUB_POSTS_PER_DAY", DEFAULT_MAX_GITHUB_POSTS_PER_DAY);
  }
  return envPositiveInt("ZYQUOR_MAX_SAME_HOST_POSTS_PER_DAY", DEFAULT_MAX_SAME_HOST_POSTS_PER_DAY);
}

function sourceRelevanceScore(item: { content: string; title: string }) {
  const text = `${item.title} ${item.content}`;
  const core = CORE_PATTERNS.reduce((score, pattern) => score + (pattern.test(text) ? 3 : 0), 0);
  const supporting = SUPPORTING_PATTERNS.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
  return core + supporting;
}

function sourceHost(url: string | null | undefined) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function isAllowedSourceUrl(url: string | null | undefined) {
  const host = sourceHost(url);
  if (!host) return true;
  if (BLOCKED_SOURCE_HOSTS.has(host)) return false;
  if (host.endsWith(".stripe.com") && /\/(buy|checkout|pay|payment|link|invoice)\b/i.test(url ?? "")) return false;
  return true;
}

function itemSourceKey(item: SourceItem) {
  const source = item.metadata?.source;
  if (typeof source === "string" && source) return source;
  try {
    return new URL(item.url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function isFreshSourceItem(item: SourceItem, now: Date) {
  const raw = item.metadata?.published ?? item.metadata?.pubDate;
  if (typeof raw !== "string" || !raw.trim()) return false;
  const publishedAt = Date.parse(raw);
  if (!Number.isFinite(publishedAt)) return false;
  const age = now.getTime() - publishedAt;
  return age >= -5 * 60 * 1000 && age <= MAX_SOURCE_AGE_MS;
}

function prioritizeSourceItems(items: SourceItem[]) {
  const groups = new Map<string, SourceItem[]>();
  for (const item of [...items].sort((a, b) => sourceRelevanceScore(b) - sourceRelevanceScore(a))) {
    const key = itemSourceKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  const prioritized: SourceItem[] = [];
  while (groups.size > 0) {
    for (const [key, group] of [...groups.entries()]) {
      const next = group.shift();
      if (next) prioritized.push(next);
      if (group.length === 0) groups.delete(key);
    }
  }
  return prioritized;
}

const PROVIDER_FAILURE_PATTERNS = [
  /insufficient credits/i,
  /per-day/i,
  /daily limit/i,
  /quota exceeded/i,
  /\b(401|403)\b/,
  /unauthorized/i,
  /invalid api key/i,
  /was not found at/i,
  /failed to start/i,
  /is not confirmed free/i,
  /ECONNREFUSED/i
];

export function isProviderFailure(message: string) {
  return PROVIDER_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

export function dailyPacketTarget(today: string): number {
  const minValue = Number(process.env.ZYQUOR_DAILY_PACKET_MIN ?? 6);
  const maxValue = Number(process.env.ZYQUOR_DAILY_PACKET_MAX ?? 10);
  const min = Math.min(20, Math.max(1, Number.isFinite(minValue) ? Math.floor(minValue) : 6));
  const max = Math.min(20, Math.max(min, Number.isFinite(maxValue) ? Math.floor(maxValue) : 10));
  let hash = 2166136261;
  for (let i = 0; i < today.length; i += 1) {
    hash ^= today.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  let state = (hash + 0x6d2b79f5) | 0;
  let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  const unit = ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  return min + Math.floor(unit * (max - min + 1));
}

export async function runAutomaticIngest(options: RunAutomaticIngestOptions) {
  const configs = await options.repository.listIngestConfigs();
  const history = await options.repository.listPostHistory();
  const performanceByType = await sourcePerformanceByType(options.repository);
  const enabled = configs
    .filter((config) => config.enabled)
    .sort(
      (left, right) =>
        configPerformanceKey(right, performanceByType) - configPerformanceKey(left, performanceByType)
    );
  const results: IngestRunResult[] = [];
  const errors: Array<{ configId: string; error: string }> = [];
  const skippedByReason = createSkipSummary();
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  const postedSourceUrls = new Set(history.map((item) => item.sourceUrl).filter((url): url is string => Boolean(url)));
  const postedHostCounts = new Map<string, number>();
  const postedTitlesByHost = new Map<string, string[]>();
  for (const item of history.filter((post) => post.postedAt.startsWith(today))) {
    const host = sourceHost(item.sourceUrl);
    if (!host) continue;
    postedHostCounts.set(host, (postedHostCounts.get(host) ?? 0) + 1);
    postedTitlesByHost.set(host, [...(postedTitlesByHost.get(host) ?? []), item.sourceTitle ?? item.postedText]);
  }
  const seenUrlsThisRun = new Set<string>();
  const seenHostsThisRun = new Map<string, number>();
  let providerFailed = false;

  const allJobs = await options.repository.listJobs();
  const carriedOverByAccount = new Map<string, number>();
  for (const job of allJobs) {
    if (job.status !== "approved" || job.mode !== "autopost" || !job.createdAt.startsWith(today)) continue;
    carriedOverByAccount.set(job.accountId, (carriedOverByAccount.get(job.accountId) ?? 0) + 1);
  }

  for (const config of enabled) {
    if (options.shouldContinue && !options.shouldContinue()) break;
    if (providerFailed) break;
    try {
      if (!isWithinScheduleWindow(config.scheduleWindowStart, config.scheduleWindowEnd, options.now)) {
        skippedByReason.scheduleWindow += 1;
        continue;
      }

      const packets = await options.repository.listSourcePackets(config.accountId);
      const todayPackets = packets.filter((packet) => packet.sourceType === config.sourceType && packet.createdAt.startsWith(today));
      const baseTarget = Math.min(config.maxPacketsPerDay, dailyPacketTarget(today));
      const adjusted = performanceAdjustedTarget(baseTarget, performanceByType.get(config.sourceType));
      const target = adjusted.target;
      const carriedOver = Math.min(carriedOverByAccount.get(config.accountId) ?? 0, target - 1);
      const effectiveCap = target - carriedOver;
      console.log(
        `[ingest] account=${config.accountId} dailyTarget=${target} carriedOver=${carriedOver} ` +
          `effectiveCap=${effectiveCap} packetsToday=${todayPackets.length} perf=${adjusted.reason}`
      );
      if (todayPackets.length >= effectiveCap) {
        skippedByReason.packetCap += 1;
        continue;
      }

      const adapter = options.adapters.get(config.sourceType);
      if (!adapter || !isSourceType(config.sourceType)) {
        continue;
      }

      const remaining = effectiveCap - todayPackets.length;
      const now = options.now ?? new Date();
      const fetchMetadata = config.sourceType === "x-feed"
        ? { ...config.metadata, accountId: config.accountId }
        : config.metadata;
      const fresh = (await adapter.fetch(fetchMetadata)).filter((item) => isFreshSourceItem(item, now));
      const onTopic = config.sourceType === "job" || config.sourceType === "x-feed" || config.sourceType === "model-releases" || config.sourceType === "goldfish"
        ? fresh
        : fresh.filter((item) => isOnTopicSourceItem(item));
      skippedByReason.offTopic += fresh.length - onTopic.length;
      const items = prioritizeSourceItems(onTopic);
      let createdForConfig = 0;

      for (const item of items) {
        if (createdForConfig >= remaining) {
          break;
        }
        const host = sourceHost(item.url);
        if (!isAllowedSourceUrl(item.url)) {
          skippedByReason.blockedUrl += 1;
          continue;
        }
        const hostPostsToday = (host ? postedHostCounts.get(host) ?? 0 : 0) + (host ? seenHostsThisRun.get(host) ?? 0 : 0);
        if (host && hostPostsToday >= sameHostPostCap(host)) {
          skippedByReason.hostCap += 1;
          continue;
        }
        if (host && hasTopicOverlap(item.title, postedTitlesByHost.get(host) ?? [])) {
          skippedByReason.topicOverlap += 1;
          continue;
        }
        if (item.url && (postedSourceUrls.has(item.url) || seenUrlsThisRun.has(item.url))) {
          skippedByReason.duplicatePostedUrl += 1;
          continue;
        }
        if (item.url) {
          seenUrlsThisRun.add(item.url);
        }
        const existing = item.url ? await options.repository.getSourcePacketByUrl(item.url, config.accountId) : null;
        if (existing) {
          skippedByReason.duplicatePacket += 1;
          continue;
        }

        let packetId: string | null = null;
        try {
          const enriched = adapter.enrich ? await adapter.enrich(item).catch(() => item) : item;
          const { summary, facts, title } =
            config.sourceType === "x-feed" ? packetFieldsFromFeedDigest(enriched) : packetFieldsFromItem(enriched);
          if (!hasEnoughSourceContext({ facts, summary, title })) {
            skippedByReason.thinContext += 1;
            continue;
          }
          if (isLowSignalSourceTitle(title)) {
            skippedByReason.lowSignal += 1;
            continue;
          }
          const tweetType = routeTweetType(
            { item: enriched, sourceName: adapter.name, sourceType: adapter.sourceType },
            config.tweetTypeMix,
            { accountId: config.accountId, now: options.now, recentPosts: history }
          );
          const packet = await options.repository.createSourcePacket({
            accountId: config.accountId,
            facts,
            sourceType: config.sourceType,
            summary,
            title,
            tweetType,
            url: enriched.url
          });
          packetId = packet.id;
          const drafted = await draftFromSourcePacket({
            generationProvider: options.generationProvider,
            packet,
            repository: options.repository,
            options: {
              autoApprove: options.autoApproveEnabled !== false,
              count: 1,
              ...(enriched.imageUrl ? { mediaUrls: [enriched.imageUrl] } : {}),
              mode: "autopost"
            }
          });

          results.push({
            configId: config.id,
            draftId: drafted.draft.id,
            jobId: drafted.approved ? drafted.approved.job.id : null,
            packetId: packet.id,
            sourceType: packet.sourceType,
            url: packet.url
          });
          createdForConfig += 1;
          options.onProgress?.({ errors: [...errors], processed: results.length });
          if (host) {
            seenHostsThisRun.set(host, (seenHostsThisRun.get(host) ?? 0) + 1);
            postedTitlesByHost.set(host, [...(postedTitlesByHost.get(host) ?? []), title]);
          }
        } catch (error) {
          if (packetId) {
            await options.repository.deleteSourcePacket(packetId).catch(() => null);
          }
          if (error instanceof TopicDraftExistsError) {
            skippedByReason.topicOverlap += 1;
            continue;
          }
          const message = error instanceof Error ? error.message : "Unknown item ingest error";
          errors.push({ configId: config.id, error: message });
          options.onProgress?.({ errors: [...errors], processed: results.length });
          if (isProviderFailure(message)) {
            providerFailed = true;
            break;
          }
        }
      }
    } catch (error) {
      errors.push({
        configId: config.id,
        error: error instanceof Error ? error.message : "Unknown ingest error"
      });
    }
  }

  return { errors, processed: results.length, results, skippedByReason };
}
