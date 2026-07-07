import type { SourceAdapter, SourceItem } from "@zyquor/adapters";
import type { DraftGenerationProvider } from "@zyquor/generation";
import type { ZyquorRepository } from "@zyquor/storage";
import { packetFieldsFromItem } from "./context.js";
import { draftFromSourcePacket } from "./draft.js";
import { inferTweetTypeFromText } from "./context.js";
import { isSourceType, isWithinScheduleWindow, pickTweetType } from "./selection.js";

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
  packetCap: number;
  scheduleWindow: number;
  thinContext: number;
  topicOverlap: number;
}

function createSkipSummary(): IngestSkipSummary {
  return {
    blockedUrl: 0,
    duplicatePacket: 0,
    duplicatePostedUrl: 0,
    hostCap: 0,
    packetCap: 0,
    scheduleWindow: 0,
    thinContext: 0,
    topicOverlap: 0
  };
}

export interface RunAutomaticIngestOptions {
  adapters: Map<string, SourceAdapter>;
  generationProvider: DraftGenerationProvider;
  now?: Date;
  repository: ZyquorRepository;
}

const PREFERRED_NEWS_KEYWORDS = [
  "ai",
  "artificial intelligence",
  "llm",
  "agent",
  "agents",
  "automation",
  "model",
  "openai",
  "anthropic",
  "google",
  "meta",
  "microsoft",
  "apple",
  "nvidia",
  "chip",
  "chips",
  "semiconductor",
  "compute",
  "datacenter",
  "data center",
  "developer",
  "programming",
  "software",
  "open source",
  "database",
  "infrastructure",
  "security",
  "privacy",
  "cybersecurity",
  "startup",
  "saas",
  "cloud",
  "robotics",
  "science",
  "research",
  "study",
  "paper",
  "arxiv",
  "physics",
  "space",
  "climate",
  "biotech",
  "healthcare",
  "medicine",
  "drug",
  "battery",
  "nuclear",
  "economy",
  "economic",
  "gdp",
  "inflation",
  "interest rate",
  "federal reserve",
  "fed",
  "central bank",
  "jobs report",
  "unemployment",
  "markets",
  "stocks",
  "bonds",
  "yield",
  "crypto",
  "bitcoin",
  "tariff",
  "supply chain",
  "regulation",
  "policy",
  "antitrust",
  "geopolitical",
  "geopolitics",
  "china",
  "india",
  "europe",
  "taiwan",
  "trade",
  "energy",
  "defense",
  "war",
  "election",
  "business",
  "earnings",
  "revenue",
  "profit",
  "layoffs",
  "funding",
  "acquisition",
  "ipo",
  "merger"
];

const BLOCKED_SOURCE_HOSTS = new Set([
  "book.stripe.com",
  "buy.stripe.com",
  "checkout.stripe.com",
  "pay.stripe.com",
  "gumroad.com"
]);
const GENERIC_TOPIC_WORDS = new Set([
  "about",
  "after",
  "agent",
  "agents",
  "built",
  "code",
  "data",
  "from",
  "github",
  "guide",
  "into",
  "model",
  "news",
  "open",
  "platform",
  "repo",
  "show",
  "source",
  "system",
  "that",
  "this",
  "tool",
  "using",
  "with"
]);
const DEFAULT_MAX_SAME_HOST_POSTS_PER_DAY = 100;
const DEFAULT_MAX_GITHUB_POSTS_PER_DAY = 100;

function envPositiveInt(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sameHostPostCap(host: string) {
  if (host === "github.com") {
    return envPositiveInt("ZYQUOR_MAX_GITHUB_POSTS_PER_DAY", DEFAULT_MAX_GITHUB_POSTS_PER_DAY);
  }
  return envPositiveInt("ZYQUOR_MAX_SAME_HOST_POSTS_PER_DAY", DEFAULT_MAX_SAME_HOST_POSTS_PER_DAY);
}

function sourceRelevanceScore(item: { content: string; title: string }) {
  const text = `${item.title} ${item.content}`.toLowerCase();
  return PREFERRED_NEWS_KEYWORDS.reduce((score, keyword) => score + (text.includes(keyword) ? 1 : 0), 0);
}

function sourceHost(url: string | null | undefined) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function topicWords(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .map((word) => word.replace(/^-+|-+$/g, ""))
      .filter((word) => word.length >= 4 && !GENERIC_TOPIC_WORDS.has(word))
      .slice(0, 12)
  );
}

function hasTopicOverlap(title: string, recentTitles: string[]) {
  const current = topicWords(title);
  if (current.size === 0) return false;
  return recentTitles.some((recent) => {
    const recentWords = topicWords(recent);
    let overlap = 0;
    for (const word of current) {
      if (recentWords.has(word)) overlap += 1;
    }
    return overlap >= 3;
  });
}

function hasEnoughSourceContext(input: { facts: string[]; summary: string; title: string }) {
  const summary = input.summary.toLowerCase();
  const title = input.title.toLowerCase();
  if (input.facts.length >= 2) return true;
  return summary.length >= 90 && summary !== title;
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

export async function runAutomaticIngest(options: RunAutomaticIngestOptions) {
  const configs = await options.repository.listIngestConfigs();
  const enabled = configs.filter((config) => config.enabled);
  const results: IngestRunResult[] = [];
  const errors: Array<{ configId: string; error: string }> = [];
  const skippedByReason = createSkipSummary();
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  const history = await options.repository.listPostHistory();
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

  for (const config of enabled) {
    try {
      if (!isWithinScheduleWindow(config.scheduleWindowStart, config.scheduleWindowEnd, options.now)) {
        skippedByReason.scheduleWindow += 1;
        continue;
      }

      const packets = await options.repository.listSourcePackets(config.accountId);
      const todayPackets = packets.filter((packet) => packet.sourceType === config.sourceType && packet.createdAt.startsWith(today));
      if (todayPackets.length >= config.maxPacketsPerDay) {
        skippedByReason.packetCap += 1;
        continue;
      }

      const adapter = options.adapters.get(config.sourceType);
      if (!adapter || !isSourceType(config.sourceType)) {
        continue;
      }

      const remaining = config.maxPacketsPerDay - todayPackets.length;
      const items = prioritizeSourceItems(await adapter.fetch(config.metadata));
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
          const { summary, facts, title } = packetFieldsFromItem(item);
          if (!hasEnoughSourceContext({ facts, summary, title })) {
            skippedByReason.thinContext += 1;
            continue;
          }
          const tweetType = pickTweetType(config.tweetTypeMix, inferTweetTypeFromText(item));
          const packet = await options.repository.createSourcePacket({
            accountId: config.accountId,
            facts,
            sourceType: config.sourceType,
            summary,
            title,
            tweetType,
            url: item.url
          });
          packetId = packet.id;
          const drafted = await draftFromSourcePacket({
            generationProvider: options.generationProvider,
            packet,
            repository: options.repository,
            options: {
              autoApprove: true,
              count: 3,
              ...(item.imageUrl ? { mediaUrls: [item.imageUrl] } : {}),
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
          if (host) {
            seenHostsThisRun.set(host, (seenHostsThisRun.get(host) ?? 0) + 1);
            postedTitlesByHost.set(host, [...(postedTitlesByHost.get(host) ?? []), title]);
          }
        } catch (error) {
          if (packetId) {
            await options.repository.deleteSourcePacket(packetId).catch(() => null);
          }
          errors.push({
            configId: config.id,
            error: error instanceof Error ? error.message : "Unknown item ingest error"
          });
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
