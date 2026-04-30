import { afterEach, describe, expect, it, vi } from "vitest";
import { createHackerNewsAdapter, createRssAdapter, createCrawl4AiService } from "./index.js";

describe("adapters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates HackerNews adapter", () => {
    const adapter = createHackerNewsAdapter();
    expect(adapter.name).toBe("hackernews");
    expect(adapter.sourceType).toBe("news");
  });

  it("creates RSS adapter", () => {
    const adapter = createRssAdapter();
    expect(adapter.name).toBe("rss");
    expect(adapter.sourceType).toBe("feed");
  });

  it("creates Crawl4AI service", () => {
    const service = createCrawl4AiService();
    expect(service).toBeDefined();
  });

  it("reads Hacker News metadata from real API-shaped responses", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/topstories.json")) {
        return { ok: true, json: async () => [42] } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          by: "pg",
          descendants: 12,
          score: 123,
          time: 1_775_000_000,
          title: "A useful HN story",
          url: "https://example.com/story"
        })
      } as Response;
    });

    const adapter = createHackerNewsAdapter({ maxItems: 1 });

    await expect(adapter.fetch()).resolves.toEqual([
      {
        content: "A useful HN story",
        metadata: {
          author: "pg",
          comments: 12,
          published: "2026-03-31T23:33:20.000Z",
          score: 123,
          sourceId: 42
        },
        title: "A useful HN story",
        url: "https://example.com/story"
      }
    ]);
  });

  it("reads RSS items from configured feed URL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => `
        <rss>
          <channel>
            <item>
              <title><![CDATA[Zyquor &amp; agents]]></title>
              <link>https://example.com/post?x=1&amp;y=2</link>
              <description><![CDATA[Useful source text]]></description>
              <media:content url="https://example.com/image.jpg" />
            </item>
          </channel>
        </rss>
      `
    } as Response);

    const adapter = createRssAdapter();
    await expect(adapter.fetch({ feedUrl: "https://example.com/feed.xml" })).resolves.toEqual([
      {
        title: "Zyquor & agents",
        url: "https://example.com/post?x=1&y=2",
        content: "Useful source text",
        imageUrl: "https://example.com/image.jpg"
      }
    ]);
  });
});
