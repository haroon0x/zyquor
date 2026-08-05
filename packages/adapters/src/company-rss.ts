import type { SourceAdapter, SourceItem } from "./types.js";
import { createRssAdapter } from "./rss.js";

export interface CompanyRssAdapterOptions {
  maxItems?: number;
  feeds?: Array<{ name: string; url: string }>;
}

export const DEFAULT_COMPANY_RSS_FEEDS = [
  { name: "openai", url: "https://openai.com/news/rss.xml" },
  { name: "openai-dev", url: "https://developers.openai.com/rss.xml" },
  { name: "anthropic", url: "https://www.anthropic.com/news/rss.xml" },
  { name: "deepmind", url: "https://deepmind.google/discover/blog/rss.xml" },
  { name: "github", url: "https://github.blog/feed/" },
  { name: "cloudflare", url: "https://blog.cloudflare.com/rss/" },
  { name: "vercel", url: "https://vercel.com/blog/rss.xml" },
  { name: "supabase", url: "https://supabase.com/blog/rss.xml" },
  { name: "stripe", url: "https://stripe.com/blog/feed.rss" },
  { name: "mistral", url: "https://mistral.ai/news/rss" },
  { name: "huggingface", url: "https://hf.co/blog/feed.xml" }
] as const;

export function createCompanyRssAdapter(options: CompanyRssAdapterOptions = {}): SourceAdapter {
  const feeds = options.feeds ?? [...DEFAULT_COMPANY_RSS_FEEDS];
  const maxItems = options.maxItems ?? 20;

  return {
    name: "company-rss",
    sourceType: "feed",
    async fetch(configMetadata = {}): Promise<SourceItem[]> {
      const configuredFeeds = parseFeeds(configMetadata.feeds) ?? feeds;
      const perFeedMax = Math.max(1, Math.ceil(maxItems / Math.max(configuredFeeds.length, 1)));
      const rss = createRssAdapter({ maxItems: perFeedMax });
      const results = await Promise.allSettled(
        configuredFeeds.map(async (feed) => {
          const items = await rss.fetch({ feedUrl: feed.url });
          return items.map((item) => ({
            ...item,
            title: `[${feed.name}] ${item.title}`,
            metadata: {
              ...item.metadata,
              feedName: feed.name,
              source: "company-rss"
            }
          }));
        })
      );

      return results
        .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
        .slice(0, maxItems);
    }
  };
}

function parseFeeds(value: unknown) {
  if (!Array.isArray(value)) return null;
  const feeds = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const maybeFeed = item as { name?: unknown; url?: unknown };
      return typeof maybeFeed.name === "string" && typeof maybeFeed.url === "string"
        ? { name: maybeFeed.name, url: maybeFeed.url }
        : null;
    })
    .filter((item): item is { name: string; url: string } => Boolean(item));
  return feeds.length ? feeds : null;
}
