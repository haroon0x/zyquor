import { describe, expect, it, vi } from "vitest";
import { createXFeedAdapter } from "./x-feed.js";

const tweets = [
  {
    id: "111",
    authorHandle: "alice",
    authorName: "Alice",
    text: "First observation about a thing",
    url: "https://x.com/alice/status/111",
    publishedAt: "2026-08-03T10:00:00.000Z",
    isRetweet: false
  },
  {
    id: "222",
    authorHandle: "bob",
    authorName: "Bob",
    text: "Second observation about another thing",
    url: "https://x.com/bob/status/222",
    publishedAt: null,
    isRetweet: true
  }
];

describe("createXFeedAdapter", () => {
  it("builds a digest item from fetched feed tweets", async () => {
    const fetchHomeFeed = vi.fn(async () => ({ tweets, url: "https://x.com/home" }));
    const resolveProfileDir = vi.fn(async () => "/tmp/profiles/personal-main");
    const adapter = createXFeedAdapter({ fetchHomeFeed, resolveProfileDir });

    const items = await adapter.fetch({ accountId: "account_personal" });

    expect(items).toHaveLength(1);
    const item = items[0]!;

    expect(fetchHomeFeed).toHaveBeenCalledWith({ profileDir: "/tmp/profiles/personal-main", maxTweets: 20 });
    expect(item.title).toMatch(/^X home feed observations \d{4}-\d{2}-\d{2}$/);
    expect(item.url).toMatch(/^https:\/\/x\.com\/home#zyquor-digest-\d{4}-\d{2}-\d{2}$/);
    expect(item.content).toBe("@alice: First observation about a thing\n@bob: Second observation about another thing");
    expect(item.metadata).toMatchObject({ source: "x-feed", type: "feed_observation" });
    expect((item.metadata?.tweets as unknown[]).length).toBe(2);
  });

  it("throws when accountId is missing from config metadata", async () => {
    const adapter = createXFeedAdapter({
      fetchHomeFeed: async () => ({ tweets, url: "https://x.com/home" }),
      resolveProfileDir: async () => "/tmp/profiles/personal-main"
    });

    await expect(adapter.fetch({})).rejects.toThrow("accountId");
  });

  it("throws when no profile dir resolves for the account", async () => {
    const adapter = createXFeedAdapter({
      fetchHomeFeed: async () => ({ tweets, url: "https://x.com/home" }),
      resolveProfileDir: async () => null
    });

    await expect(adapter.fetch({ accountId: "account_x" })).rejects.toThrow("No profile dir");
  });
});
