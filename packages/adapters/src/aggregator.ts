import type { SourceAdapter, SourceItem, CrawlService } from "./types.js";
import { createHackerNewsAdapter } from "./hackernews.js";
import { createRedditAdapter } from "./reddit.js";
import { createTechCrunchAdapter } from "./techcrunch.js";
import { createArxivAdapter } from "./arxiv.js";

export interface AggregatedItem extends SourceItem {
  source: string;
  sourceType: string;
  engagementScore: number;
  topicTags: string[];
  freshness: number;
}

export interface AggregatorOptions {
  crawlService?: CrawlService;
  maxItems?: number;
  includeReddit?: boolean;
  includeTechCrunch?: boolean;
  includeArxiv?: boolean;
  requireTopicMatch?: boolean;
}

const PREFERRED_TOPIC_KEYWORDS = [
  "ai", "ml", "llm", "gpt", "openai", "anthropic", "google", "microsoft",
  "startup", "funding", "product", "api", "developer", "programming",
  "security", "privacy", "crypto", "web3", "saas", "cloud", "rust", "python",
  "science", "research", "paper", "arxiv", "climate", "energy", "battery",
  "biotech", "healthcare", "economy", "markets", "inflation", "rates",
  "policy", "regulation", "geopolitics", "defense", "semiconductor", "chips"
];

export async function aggregateSources(options: AggregatorOptions = {}): Promise<AggregatedItem[]> {
  const {
    crawlService,
    maxItems = 20,
    includeReddit = true,
    includeTechCrunch = true,
    includeArxiv = true,
    requireTopicMatch = false
  } = options;

  const adapters: Array<{ adapter: SourceAdapter; name: string }> = [
    { adapter: createHackerNewsAdapter({ crawlService: crawlService!, maxItems: 10 }), name: "hackernews" }
  ];

  if (includeReddit) {
    adapters.push(
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "programming", maxItems: 5 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "technology", maxItems: 5 }), name: "reddit" },
      { adapter: createRedditAdapter({ crawlService: crawlService!, subreddit: "MachineLearning", maxItems: 5 }), name: "reddit" }
    );
  }

  if (includeTechCrunch) {
    adapters.push({ adapter: createTechCrunchAdapter({ crawlService: crawlService!, sections: ["ai", "startups"], maxItems: 8 }), name: "techcrunch" });
  }

  if (includeArxiv) {
    adapters.push({ adapter: createArxivAdapter({ categories: ["cs.AI", "cs.LG", "cs.CL"], maxItems: 5 }), name: "arxiv" });
  }

  const results = await Promise.allSettled(
    adapters.map(async ({ adapter, name }) => {
      const items = await adapter.fetch();
      return { items, sourceName: name, sourceType: adapter.sourceType };
    })
  );

  const aggregated: AggregatedItem[] = [];

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { items, sourceName, sourceType } = result.value;

    for (const item of items) {
      const text = `${item.title} ${item.content}`.toLowerCase();
      const hasPreferredTopic = PREFERRED_TOPIC_KEYWORDS.some(kw => text.includes(kw));

      if (requireTopicMatch && !hasPreferredTopic && sourceName !== "hackernews") continue;

      const topicTags = extractTopicTags(text);
      const freshness = calculateFreshness(item);
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

  aggregated.sort((a, b) => b.engagementScore - a.engagementScore);
  return aggregated.slice(0, maxItems);
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
      const requireTopicMatch =
        typeof metadata.requireTopicMatch === "boolean" ? metadata.requireTopicMatch : options.requireTopicMatch;
      const maxItems = typeof metadata.maxItems === "number" ? metadata.maxItems : options.maxItems;

      return aggregateSources({
        ...options,
        ...(maxItems ? { maxItems } : {}),
        ...(includeReddit !== undefined ? { includeReddit } : {}),
        ...(includeTechCrunch !== undefined ? { includeTechCrunch } : {}),
        ...(includeArxiv !== undefined ? { includeArxiv } : {}),
        ...(requireTopicMatch !== undefined ? { requireTopicMatch } : {})
      });
    }
  };
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

function calculateFreshness(item: SourceItem): number {
  const dateStr = (item.metadata?.published as string) || (item.metadata?.pubDate as string);
  if (dateStr) {
    const date = new Date(dateStr);
    if (!isNaN(date.getTime())) {
      const ageHours = (Date.now() - date.getTime()) / (1000 * 60 * 60);
      return Math.max(0, 1 - ageHours / 72);
    }
  }
  return 0.5;
}

function estimateEngagement(item: SourceItem, source: string, tags: string[], hasPreferredTopic: boolean): number {
  let score = 50;
  const sourceMult: Record<string, number> = { hackernews: 1.5, techcrunch: 1.3, arxiv: 0.9, reddit: 1.2 };
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
