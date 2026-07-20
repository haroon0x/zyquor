import type { CrawlService, SourceAdapter, SourceItem } from "./types.js";

const HN_SEARCH_API = "https://hn.algolia.com/api/v1/search_by_date";

export interface HackerNewsSearchAdapterOptions {
  crawlService?: CrawlService;
  maxItems?: number;
  now?: Date;
  topic: string;
}

export function createHackerNewsSearchAdapter(options: HackerNewsSearchAdapterOptions): SourceAdapter {
  const maxItems = options.maxItems ?? 10;
  const now = options.now ?? new Date();

  return {
    name: "hackernews-search",
    sourceType: "news",
    async fetch(): Promise<SourceItem[]> {
      const url = new URL(HN_SEARCH_API);
      url.searchParams.set("query", options.topic);
      url.searchParams.set("tags", "story");
      url.searchParams.set("hitsPerPage", String(Math.min(Math.max(maxItems, 1), 50)));
      url.searchParams.set("numericFilters", `created_at_i>${Math.floor((now.getTime() - 14 * 24 * 60 * 60 * 1000) / 1000)}`);

      try {
        const response = await globalThis.fetch(url, {
          headers: { "User-Agent": "Zyquor/1.0" }
        });
        if (!response.ok) return [];
        const body = (await response.json()) as { hits?: HackerNewsSearchHit[] };
        const items: SourceItem[] = [];

        for (const hit of body.hits ?? []) {
          const title = hit.title?.trim();
          if (!title || !hit.created_at) continue;
          const storyUrl = hit.url?.trim() || `https://news.ycombinator.com/item?id=${hit.objectID}`;
          let content = hit.story_text?.trim() || title;
          if (hit.url && options.crawlService) {
            try {
              const crawled = await options.crawlService.crawl(hit.url);
              content = crawled.markdown.trim().slice(0, 3000) || content;
            } catch {}
          }
          items.push({
            title,
            url: storyUrl,
            content,
            metadata: {
              author: hit.author ?? null,
              comments: hit.num_comments ?? 0,
              published: hit.created_at,
              score: hit.points ?? 0,
              source: "hackernews-search",
              sourceId: hit.objectID
            }
          });
        }

        return items;
      } catch {
        return [];
      }
    }
  };
}

interface HackerNewsSearchHit {
  author?: string;
  created_at?: string;
  num_comments?: number;
  objectID: string;
  points?: number;
  story_text?: string | null;
  title?: string | null;
  url?: string | null;
}
