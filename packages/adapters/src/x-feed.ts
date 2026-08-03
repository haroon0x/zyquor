import type { XFeedTweet } from "@zyquor/browser";
import type { SourceAdapter, SourceItem } from "./types.js";

export interface XFeedAdapterOptions {
  fetchHomeFeed: (input: { profileDir: string; maxTweets?: number }) => Promise<{ tweets: XFeedTweet[]; url: string }>;
  resolveProfileDir: (accountId: string) => Promise<string | null>;
}

function digestDate(now: Date) {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function createXFeedAdapter(options: XFeedAdapterOptions): SourceAdapter {
  return {
    name: "x-feed",
    sourceType: "x-feed",
    async fetch(configMetadata) {
      const accountId = configMetadata?.accountId;
      if (typeof accountId !== "string" || !accountId) {
        throw new Error("x-feed adapter requires accountId in config metadata");
      }
      const profileDir = await options.resolveProfileDir(accountId);
      if (!profileDir) {
        throw new Error(`No profile dir found for account ${accountId}`);
      }

      const { tweets } = await options.fetchHomeFeed({ profileDir, maxTweets: 20 });
      const now = new Date();
      const date = digestDate(now);
      const lines = tweets
        .filter((tweet) => tweet.text.trim().length > 0)
        .map((tweet) => `@${tweet.authorHandle}: ${tweet.text}`);

      const item: SourceItem = {
        title: `X home feed observations ${date}`,
        url: `https://x.com/home#zyquor-digest-${date}`,
        content: lines.join("\n"),
        metadata: {
          source: "x-feed",
          published: now.toISOString(),
          type: "feed_observation",
          tweets: tweets.map((tweet) => ({
            id: tweet.id,
            authorHandle: tweet.authorHandle,
            authorName: tweet.authorName,
            text: tweet.text,
            url: tweet.url,
            publishedAt: tweet.publishedAt,
            isRetweet: tweet.isRetweet
          }))
        }
      };

      return [item];
    }
  };
}
