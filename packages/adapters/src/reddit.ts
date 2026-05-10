import type { SourceAdapter, SourceItem, CrawlService } from "./types.js";

const REDDIT_API_BASE = "https://www.reddit.com";

export interface RedditAdapterOptions {
  crawlService?: CrawlService;
  maxItems?: number;
  minComments?: number;
  minScore?: number;
  subreddit?: string;
  sortBy?: "hot" | "new" | "top" | "rising";
}

/**
 * Fetches trending posts from a subreddit or Reddit's front page.
 * Best for: tech discussions, developer tools, programming, AI/ML communities
 */
export function createRedditAdapter(options: RedditAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 10;
  const minComments = options.minComments ?? 0;
  const minScore = options.minScore ?? 0;
  const subreddit = options.subreddit ?? "";
  const sortBy = options.sortBy ?? "hot";

  return {
    name: "reddit",
    sourceType: "feed",
    async fetch(): Promise<SourceItem[]> {
      try {
        const base = subreddit
          ? `${REDDIT_API_BASE}/r/${subreddit}/${sortBy}.json`
          : `${REDDIT_API_BASE}/${sortBy}.json`;

        const res = await globalThis.fetch(base, {
          headers: { "User-Agent": "Zyquor/1.0" }
        });
        if (!res.ok) return [];

        const data = await res.json() as { data?: { children?: Array<{ data: RedditPost }> } };
        const posts = data?.data?.children ?? [];
        const items: SourceItem[] = [];

        for (const { data: post } of posts.slice(0, maxItems)) {
          if (post.pinned || post.stickied) continue;
          if (post.score < minScore || post.num_comments < minComments) continue;

          // Skip memes, images, NSFW
          if (post.over_18 || post.is_self === false && post.is_video) continue;

          let content = post.selftext || post.title;

          // If has URL and no selftext, crawl it
          if (post.url && post.is_self === false && !post.is_video && post.domain !== 'self.' + (subreddit || 'reddit')) {
            if (options.crawlService) {
              try {
                const crawled = await options.crawlService.crawl(post.url);
                content = (crawled.markdown || "").trim().slice(0, 3000) || content;
              } catch {}
            }
          }

          items.push({
            title: post.title,
            url: `https://reddit.com${post.permalink}`,
            content,
            metadata: {
              subreddit: post.subreddit,
              score: post.score,
              numComments: post.num_comments,
              upvoteRatio: post.upvote_ratio
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

interface RedditPost {
  title: string;
  selftext: string;
  url: string;
  permalink: string;
  subreddit: string;
  score: number;
  num_comments: number;
  upvote_ratio: number;
  over_18: boolean;
  is_self: boolean;
  is_video: boolean;
  domain: string;
  pinned: boolean;
  stickied: boolean;
}
