import type { SourceAdapter, SourceItem, CrawlService } from "./types.js";
import { createHackerNewsAdapter } from "./hackernews.js";
import { createHackerNewsSearchAdapter } from "./hackernews-search.js";
import { createRedditAdapter } from "./reddit.js";
import { createTechCrunchAdapter } from "./techcrunch.js";
import { createArxivAdapter } from "./arxiv.js";
import { createGitHubTrendingAdapter } from "./github.js";
import { createProductHuntAdapter } from "./producthunt.js";
import { createCompanyRssAdapter } from "./company-rss.js";
import { createHiringAdapter } from "./hiring.js";
import { createGdeltAdapter } from "./gdelt.js";

export interface AggregatedItem extends SourceItem {
  source: string;
  sourceType: string;
  engagementScore: number;
  topicTags: string[];
  freshness: number;
}

export interface AggregatorOptions {
  crawlService?: CrawlService;
  healthCooldownMs?: number;
  maxItems?: number;
  includeReddit?: boolean;
  includeTechCrunch?: boolean;
  includeArxiv?: boolean;
  includeGitHub?: boolean;
  includeProductHunt?: boolean;
  includeCompanyRss?: boolean;
  includeExpandedHackerNews?: boolean;
  includeHiring?: boolean;
  now?: Date;
  requireTopicMatch?: boolean;
  topic?: string;
}

export interface SourceHealthSnapshot {
  consecutiveFailures: number;
  lastError: string | null;
  lastFailureAt: string | null;
  lastItemCount: number;
  lastSuccessAt: string | null;
  name: string;
  skippedUntil: string | null;
  successCount: number;
}

const PREFERRED_TOPIC_KEYWORDS = [
  "ai", "ml", "llm", "gpt", "openai", "anthropic", "google", "microsoft",
  "startup", "funding", "product", "api", "developer", "programming",
  "security", "privacy", "crypto", "web3", "saas", "cloud", "rust", "python",
  "science", "research", "paper", "arxiv", "climate", "energy", "battery",
  "biotech", "healthcare", "economy", "markets", "inflation", "rates",
  "policy", "regulation", "geopolitics", "defense", "semiconductor", "chips"
];

const DEFAULT_HEALTH_COOLDOWN_MS = 15 * 60 * 1000;
const sourceHealth = new Map<string, SourceHealthSnapshot>();

export function getAggregatedSourceHealth(): SourceHealthSnapshot[] {
  return [...sourceHealth.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function resetAggregatedSourceHealth() {
  sourceHealth.clear();
}

export async function aggregateSources(options: AggregatorOptions = {}): Promise<AggregatedItem[]> {
  const {
    crawlService,
    maxItems = 20,
    includeReddit = true,
    includeTechCrunch = true,
    includeArxiv = true,
    includeGitHub = true,
    includeProductHunt = true,
    includeCompanyRss = true,
    includeExpandedHackerNews = true,
    includeHiring = true,
    healthCooldownMs = DEFAULT_HEALTH_COOLDOWN_MS,
    now = new Date(),
    requireTopicMatch = false,
    topic
  } = options;

  const query = topicQuery(topic);

  const adapters: Array<{ adapter: SourceAdapter; name: string }> = [
    query
      ? { adapter: createHackerNewsSearchAdapter({ maxItems: 12, now, topic: query }), name: "hackernews" }
      : { adapter: createHackerNewsAdapter({ crawlService: crawlService!, maxItems: 10 }), name: "hackernews" }
  ];

  if (query) {
    adapters.unshift({ adapter: createGdeltAdapter({ maxItems: 20, topic: query }), name: "gdelt" });
  }

  if (includeExpandedHackerNews && !query) {
    adapters.push(
      { adapter: createHackerNewsAdapter({ crawlService: crawlService!, feed: "beststories", maxItems: 8 }), name: "hackernews" },
      { adapter: createHackerNewsAdapter({ crawlService: crawlService!, feed: "newstories", maxItems: 8 }), name: "hackernews" },
      { adapter: createHackerNewsAdapter({ crawlService: crawlService!, feed: "showstories", maxItems: 6 }), name: "hackernews" },
      { adapter: createHackerNewsAdapter({ crawlService: crawlService!, feed: "askstories", maxItems: 4 }), name: "hackernews" }
    );
  }

  if (includeReddit && !query) {
    adapters.push(
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "programming", maxItems: 5, minScore: 20 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "technology", maxItems: 5, minScore: 20 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "MachineLearning", maxItems: 5, minScore: 10 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "LocalLLaMA", maxItems: 5, minScore: 10 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "OpenAI", maxItems: 5, minScore: 10 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "singularity", maxItems: 5, minScore: 20 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "SaaS", maxItems: 5, minScore: 5 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "startups", maxItems: 5, minScore: 5 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "SideProject", maxItems: 5, minScore: 5 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "webdev", maxItems: 5, minScore: 10 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "selfhosted", maxItems: 5, minScore: 10 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "datascience", maxItems: 5, minScore: 10 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "cybersecurity", maxItems: 5, minScore: 10 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "Futurology", maxItems: 5, minScore: 20 }), name: "reddit" }
    );
  }

  if (includeTechCrunch && !query) {
    adapters.push({ adapter: createTechCrunchAdapter({ crawlService: crawlService!, sections: ["ai", "startups"], maxItems: 8 }), name: "techcrunch" });
  }

  if (includeArxiv) {
    adapters.push({
      adapter: query
        ? createArxivAdapter({ searchQuery: `all:\"${query.replace(/\"/g, "")}\"`, maxItems: 12 })
        : createArxivAdapter({ categories: ["cs.AI", "cs.LG", "cs.CL", "cs.CV", "cs.RO", "cs.CR", "cs.DB", "cs.SE", "stat.ML", "econ.GN", "q-fin"], maxItems: 8 }),
      name: "arxiv"
    });
  }

  if (includeGitHub) {
    if (query) {
      adapters.push({ adapter: createGitHubTrendingAdapter({ query, minStars: 0, maxItems: 12 }), name: "github" });
    } else {
      adapters.push(
        { adapter: createGitHubTrendingAdapter({ topic: "ai", maxItems: 6 }), name: "github" },
        { adapter: createGitHubTrendingAdapter({ topic: "llm", maxItems: 6 }), name: "github" },
        { adapter: createGitHubTrendingAdapter({ topic: "agents", maxItems: 6 }), name: "github" },
        { adapter: createGitHubTrendingAdapter({ topic: "developer-tools", maxItems: 6 }), name: "github" }
      );
    }
  }

  if (includeProductHunt && !query) {
    adapters.push({ adapter: createProductHuntAdapter({ maxItems: 10 }), name: "producthunt" });
  }

  if (includeCompanyRss && !query) {
    adapters.push({ adapter: createCompanyRssAdapter({ maxItems: 12 }), name: "company-rss" });
  }

  if (includeHiring && !query) {
    adapters.push({ adapter: createHiringAdapter({ maxItems: 8 }), name: "hiring" });
  }

  const activeAdapters = adapters.filter(({ adapter }) => !isSourceCoolingDown(adapter.name, now));
  const results = await Promise.allSettled(
    activeAdapters.map(async ({ adapter, name }) => {
      const items = await adapter.fetch();
      return { items, sourceName: name, sourceType: adapter.sourceType };
    })
  );

  const aggregated: AggregatedItem[] = [];

  for (const [index, result] of results.entries()) {
    const adapter = activeAdapters[index]?.adapter;
    if (result.status !== "fulfilled") {
      if (adapter) recordSourceFailure(adapter.name, result.reason, now, healthCooldownMs);
      continue;
    }
    const { items, sourceName, sourceType } = result.value;
    if (adapter) {
      if (items.length === 0) recordSourceFailure(adapter.name, "No items returned", now, healthCooldownMs);
      else recordSourceSuccess(adapter.name, items.length, now);
    }

    for (const item of items) {
      const text = `${item.title} ${item.content}`.toLowerCase();
      const hasPreferredTopic = PREFERRED_TOPIC_KEYWORDS.some(kw => text.includes(kw));

      if (query && !isFreshTopicItem(item, now)) continue;
      if (query && !matchesTopic(text, query)) continue;
      if (requireTopicMatch && !hasPreferredTopic && sourceName !== "hackernews") continue;

      const topicTags = extractTopicTags(text);
      const freshness = calculateFreshness(item, now);
      const engagementScore = estimateEngagement(item, sourceName, topicTags, hasPreferredTopic);

      aggregated.push({
        ...item,
        source: sourceName,
        sourceType,
        topicTags,
        freshness,
        engagementScore
      });
    }
  }

  aggregated.sort((a, b) => query
    ? b.freshness - a.freshness || b.engagementScore - a.engagementScore
    : b.engagementScore - a.engagementScore);
  return aggregated.slice(0, maxItems);
}

function emptyHealth(name: string): SourceHealthSnapshot {
  return {
    consecutiveFailures: 0,
    lastError: null,
    lastFailureAt: null,
    lastItemCount: 0,
    lastSuccessAt: null,
    name,
    skippedUntil: null,
    successCount: 0
  };
}

function isSourceCoolingDown(name: string, now: Date) {
  const health = sourceHealth.get(name);
  if (!health?.skippedUntil) return false;
  return new Date(health.skippedUntil).getTime() > now.getTime();
}

function recordSourceSuccess(name: string, itemCount: number, now: Date) {
  const current = sourceHealth.get(name) ?? emptyHealth(name);
  sourceHealth.set(name, {
    ...current,
    consecutiveFailures: 0,
    lastError: null,
    lastItemCount: itemCount,
    lastSuccessAt: now.toISOString(),
    skippedUntil: null,
    successCount: current.successCount + 1
  });
}

function recordSourceFailure(name: string, error: unknown, now: Date, cooldownMs: number) {
  const current = sourceHealth.get(name) ?? emptyHealth(name);
  const consecutiveFailures = current.consecutiveFailures + 1;
  sourceHealth.set(name, {
    ...current,
    consecutiveFailures,
    lastError: error instanceof Error ? error.message : String(error),
    lastFailureAt: now.toISOString(),
    lastItemCount: 0,
    skippedUntil: consecutiveFailures >= 2 ? new Date(now.getTime() + cooldownMs).toISOString() : current.skippedUntil
  });
}

export function createAggregatedNewsAdapter(options: AggregatorOptions = {}): SourceAdapter {
  return {
    name: "aggregated-news",
    sourceType: "news",
    async fetch(metadata = {}) {
      const includeReddit = typeof metadata.includeReddit === "boolean" ? metadata.includeReddit : options.includeReddit;
      const includeTechCrunch =
        typeof metadata.includeTechCrunch === "boolean" ? metadata.includeTechCrunch : options.includeTechCrunch;
      const includeArxiv = typeof metadata.includeArxiv === "boolean" ? metadata.includeArxiv : options.includeArxiv;
      const includeGitHub = typeof metadata.includeGitHub === "boolean" ? metadata.includeGitHub : options.includeGitHub;
      const includeProductHunt =
        typeof metadata.includeProductHunt === "boolean" ? metadata.includeProductHunt : options.includeProductHunt;
      const includeCompanyRss =
        typeof metadata.includeCompanyRss === "boolean" ? metadata.includeCompanyRss : options.includeCompanyRss;
      const includeExpandedHackerNews =
        typeof metadata.includeExpandedHackerNews === "boolean"
          ? metadata.includeExpandedHackerNews
          : options.includeExpandedHackerNews;
      const includeHiring = typeof metadata.includeHiring === "boolean" ? metadata.includeHiring : options.includeHiring;
      const requireTopicMatch =
        typeof metadata.requireTopicMatch === "boolean" ? metadata.requireTopicMatch : options.requireTopicMatch;
      const maxItems = typeof metadata.maxItems === "number" ? metadata.maxItems : options.maxItems;
      const topic = typeof metadata.topic === "string" ? metadata.topic : options.topic;

      return aggregateSources({
        ...options,
        ...(topic ? { topic } : {}),
        ...(maxItems ? { maxItems } : {}),
        ...(includeReddit !== undefined ? { includeReddit } : {}),
        ...(includeTechCrunch !== undefined ? { includeTechCrunch } : {}),
        ...(includeArxiv !== undefined ? { includeArxiv } : {}),
        ...(includeGitHub !== undefined ? { includeGitHub } : {}),
        ...(includeProductHunt !== undefined ? { includeProductHunt } : {}),
        ...(includeCompanyRss !== undefined ? { includeCompanyRss } : {}),
        ...(includeExpandedHackerNews !== undefined ? { includeExpandedHackerNews } : {}),
        ...(includeHiring !== undefined ? { includeHiring } : {}),
        ...(requireTopicMatch !== undefined ? { requireTopicMatch } : {})
      });
    }
  };
}

function topicQuery(value: string | undefined) {
  if (!value?.trim()) return "";
  const ignored = new Set(["about", "after", "before", "from", "have", "into", "just", "latest", "post", "that", "their", "then", "this", "tweet", "what", "when", "where", "which", "with", "write"]);
  return value
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9+#.-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !ignored.has(word))
    .slice(0, 8)
    .join(" ");
}

function matchesTopic(text: string, query: string) {
  const words = [...new Set(query.split(/\s+/).filter(Boolean))];
  const textWords = new Set(text.match(/[a-z0-9+#.-]+/g) ?? []);
  const matches = words.filter((word) => textWords.has(word)).length;
  return matches >= Math.min(2, Math.ceil(words.length / 2));
}

function isFreshTopicItem(item: SourceItem, now: Date) {
  const raw = item.metadata?.published ?? item.metadata?.pubDate;
  if (typeof raw !== "string") return false;
  const publishedAt = Date.parse(raw);
  if (!Number.isFinite(publishedAt)) return false;
  const age = now.getTime() - publishedAt;
  return age >= -5 * 60 * 1000 && age <= 48 * 60 * 60 * 1000;
}

function extractTopicTags(text: string): string[] {
  const tags: string[] = [];
  const tagMap: Record<string, string[]> = {
    ai: ["ai", "ml", "llm", "gpt", "neural"],
    startups: ["startup", "funding", "vc"],
    devtools: ["developer", "programming", "api"],
    security: ["security", "hack", "vulnerability"],
    cloud: ["cloud", "aws", "kubernetes"],
    business: ["saas", "revenue", "growth"],
    research: ["research", "paper", "arxiv"],
    science: ["science", "climate", "energy", "battery", "biotech", "healthcare"],
    economy: ["economy", "markets", "inflation", "rates"],
    policy: ["policy", "regulation", "geopolitics", "defense"]
  };
  for (const [tag, keywords] of Object.entries(tagMap)) {
    if (keywords.some(kw => text.includes(kw))) tags.push(tag);
  }
  return tags.length > 0 ? tags : ["general"];
}

function calculateFreshness(item: SourceItem, now = new Date()): number {
  const dateStr = (item.metadata?.published as string) || (item.metadata?.pubDate as string);
  if (dateStr) {
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      const ageHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);
      return Math.max(0, 1 - ageHours / 72);
    }
  }
  return 0.5;
}

function estimateEngagement(item: SourceItem, source: string, tags: string[], hasPreferredTopic: boolean): number {
  let score = 50;
  const sourceMult: Record<string, number> = { hackernews: 1.5, techcrunch: 1.3, arxiv: 0.9, reddit: 1.2, github: 1.25, producthunt: 1.15, "company-rss": 1.35, hiring: 1.1 };
  score *= sourceMult[source] || 1;

  const highEngPatterns = [/how i|how we/i, /built|building/i, /\d+x|\d+%/i, /mistake|lesson/i, /open.?source/i];
  for (const p of highEngPatterns) {
    if (p.test(item.title)) score += 10;
  }

  if (source === "reddit") {
    const upvotes = (item.metadata?.score as number) || 0;
    const comments = (item.metadata?.numComments as number) || 0;
    score += Math.log10(upvotes + 1) * 5;
    score += Math.log10(comments + 1) * 3;
  }
  if (source === "github") {
    const stars = (item.metadata?.stars as number) || 0;
    score += Math.log10(stars + 1) * 4;
  }
  if (source === "producthunt") {
    const votes = (item.metadata?.votes as number) || 0;
    const comments = (item.metadata?.comments as number) || 0;
    score += Math.log10(votes + 1) * 5;
    score += Math.log10(comments + 1) * 3;
  }

  if (tags.includes("ai")) score += 15;
  if (tags.includes("startups")) score += 10;
  if (tags.includes("science")) score += 8;
  if (tags.includes("economy")) score += 8;
  if (tags.includes("policy")) score += 6;
  if (hasPreferredTopic) score += 5;

  return Math.round(score);
}

export function inferTweetType(item: SourceItem): string {
  const title = item.title.toLowerCase();
  if (/how to|tutorial|guide/i.test(title)) return "guide";
  if (/mistake|wrong|lesson|learned/i.test(title)) return "lesson";
  if (/opinion|think|believe|should/i.test(title)) return "opinion";
  if (/tool|app|product|launch/i.test(title)) return "tool";
  if (/study|research|paper/i.test(item.content.toLowerCase())) return "useful_info";
  return "feed_observation";
}
