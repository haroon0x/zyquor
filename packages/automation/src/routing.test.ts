import { describe, expect, it } from "vitest";
import { routeTweetType, type RecentPostType } from "./routing.js";

const item = {
  title: "A concrete source item",
  url: "https://example.com/source",
  content: "A concrete fact about the source item."
};

function recent(
  type: string,
  postedAt: string,
  postUrl = `https://x.com/p/${postedAt}`,
  postedText = `a real insight ${postedAt}`
): RecentPostType {
  return { accountId: "account_a", postUrl, postedAt, postedText, tweetType: type };
}

describe("routeTweetType", () => {
  it("routes job adapters to hiring", () => {
    expect(routeTweetType({ item, sourceName: "hiring-hackernews", sourceType: "job" }, { opinion: 100 })).toBe("hiring");
  });

  it("routes hiring metadata from aggregated sources to hiring", () => {
    expect(
      routeTweetType(
        { item: { ...item, metadata: { source: "hackernews-jobs", type: "hiring" } }, sourceType: "news" },
        { opinion: 100 }
      )
    ).toBe("hiring");
  });

  it("routes RSS and feed adapters through the configured mix", () => {
    expect(routeTweetType({ item, sourceName: "rss", sourceType: "feed" }, { useful_info: 100 })).toBe("useful_info");
  });

  it("routes feed items inside aggregated news through the configured mix", () => {
    const aggregatedItem = { ...item, source: "company-rss", sourceType: "feed" };
    expect(
      routeTweetType(
        { item: aggregatedItem, sourceName: "aggregated-news", sourceType: "news" },
        { news_context: 100 }
      )
    ).toBe("news_context");
  });

  it("uses the configured mix for other sources", () => {
    expect(routeTweetType({ item, sourceName: "hackernews", sourceType: "news" }, { news_context: 100 })).toBe("news_context");
  });

  it("routes x-feed digests to feed observations", () => {
    expect(routeTweetType({ item, sourceType: "x-feed" }, { opinion: 100 })).toBe("feed_observation");
  });

  it("excludes types that already hit the daily cap", () => {
    const today = new Date().toISOString();
    const posts = [1, 2, 3].map((index) => recent("article_summary", today, `https://x.com/p/today-${index}`));
    const result = routeTweetType(
      { item, sourceName: "rss", sourceType: "feed" },
      { article_summary: 100 },
      { accountId: "account_a", recentPosts: posts }
    );
    expect(result).not.toBe("article_summary");
  });

  it("ignores link-only reply entries regardless of post URL", () => {
    const today = new Date().toISOString();
    const posts = [1, 2, 3].flatMap((index) => [
      recent("article_summary", today, `https://x.com/p/main-${index}`),
      recent("article_summary", today, `https://x.com/p/reply-${index}`, `https://arxiv.org/abs/2608.${index}`)
    ]);
    const result = routeTweetType(
      { item, sourceName: "rss", sourceType: "feed" },
      { article_summary: 100 },
      { accountId: "account_a", recentPosts: posts }
    );
    expect(result).not.toBe("article_summary");
  });

  it("blocks a type that saturates the rolling window", () => {
    const windowPosts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((index) =>
      recent("opinion", `2026-08-01T00:0${index}:00Z`)
    );
    const result = routeTweetType(
      { item, sourceName: "hackernews", sourceType: "news" },
      { opinion: 100, useful_info: 1 },
      { accountId: "account_a", recentPosts: windowPosts }
    );
    expect(result).toBe("useful_info");
  });

  it("penalizes the type of the most recent post without blocking it outright", () => {
    const posts = [recent("opinion", "2026-08-01T00:10:00Z")];
    const result = routeTweetType(
      { item, sourceName: "hackernews", sourceType: "news" },
      { opinion: 100, useful_info: 1 },
      { accountId: "account_a", recentPosts: posts }
    );
    expect(["opinion", "useful_info"]).toContain(result);
  });
});