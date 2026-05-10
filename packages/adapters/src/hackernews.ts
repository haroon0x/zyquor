import type { SourceAdapter, SourceItem, CrawlService } from "./types.js";

const HN_API_BASE = "https://hacker-news.firebaseio.com/v0";

export interface HackerNewsAdapterOptions {
  crawlService?: CrawlService;
  feed?: "askstories" | "beststories" | "newstories" | "showstories" | "topstories";
  maxItems?: number;
}

export function createHackerNewsAdapter(options: HackerNewsAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 5;
  const crawlService = options.crawlService;
  const feed = options.feed ?? "topstories";

  return {
    name: feed === "topstories" ? "hackernews" : `hackernews-${feed.replace("stories", "")}`,
    sourceType: "news",
    async fetch(): Promise<SourceItem[]> {
      try {
        const topRes = await globalThis.fetch(`${HN_API_BASE}/${feed}.json`);
        if (!topRes.ok) return [];

        const topIds = (await topRes.json()) as number[];
        const items: SourceItem[] = [];

        for (const id of topIds.slice(0, maxItems)) {
          try {
            const itemRes = await globalThis.fetch(`${HN_API_BASE}/item/${id}.json`);
            if (!itemRes.ok) continue;

            const hnItem = (await itemRes.json()) as {
              by?: string;
              descendants?: number;
              score?: number;
              time?: number;
              title?: string;
              url?: string;
              text?: string;
            };

            if (!hnItem?.title) continue;

            const url = hnItem.url || `https://news.ycombinator.com/item?id=${id}`;
            let content = hnItem.text || "";

            if (hnItem.url && !content && crawlService) {
              try {
                const crawlResult = await crawlService.crawl(hnItem.url);
                content = (crawlResult.markdown || "").trim().slice(0, 3000);
              } catch {
                // Crawl failed, continue with empty content
              }
            }

            items.push({
              title: hnItem.title,
              url,
              content: content || hnItem.title,
              metadata: {
                author: hnItem.by ?? null,
                comments: hnItem.descendants ?? 0,
                published: hnItem.time ? new Date(hnItem.time * 1000).toISOString() : null,
                score: hnItem.score ?? 0,
                sourceId: id
              }
            });
          } catch {
            // Ignore individual item errors
          }
        }
        return items;
      } catch {
        return [];
      }
    }
  };
}
