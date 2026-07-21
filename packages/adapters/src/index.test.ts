import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateSources,
  createAggregatedNewsAdapter,
  createCompanyRssAdapter,
  createCrawl4AiService,
  createGitHubTrendingAdapter,
  createHiringAdapter,
  createHackerNewsAdapter,
  createProductHuntAdapter,
  createRssAdapter,
  getAggregatedSourceHealth,
  resetAggregatedSourceHealth
} from "./index.js";

describe("adapters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAggregatedSourceHealth();
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

  it("creates expanded source adapters", () => {
    expect(createHackerNewsAdapter({ feed: "beststories" }).name).toBe("hackernews-best");
    expect(createGitHubTrendingAdapter().name).toBe("github-trending");
    expect(createProductHuntAdapter().name).toBe("producthunt");
    expect(createCompanyRssAdapter().name).toBe("company-rss");
    expect(createHiringAdapter().name).toBe("hiring-hackernews");
  });

  it("creates aggregated news adapter", () => {
    const adapter = createAggregatedNewsAdapter();
    expect(adapter.name).toBe("aggregated-news");
    expect(adapter.sourceType).toBe("news");
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

  it("reads an alternate Hacker News feed", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/showstories.json")) {
        return { ok: true, json: async () => [99] } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          score: 42,
          time: 1_775_000_000,
          title: "Show HN: Useful developer agent",
          url: "https://example.com/show"
        })
      } as Response;
    });

    const adapter = createHackerNewsAdapter({ feed: "showstories", maxItems: 1 });

    await expect(adapter.fetch()).resolves.toEqual([
      expect.objectContaining({
        title: "Show HN: Useful developer agent",
        url: "https://example.com/show"
      })
    ]);
  });

  it("reads verified Hacker News hiring posts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("/jobstories.json")) {
        return { ok: true, json: async () => [123] } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          by: "founder",
          text: "Remote infra engineer role.",
          time: 1_775_000_000,
          title: "ExampleCo is hiring infra engineers",
          url: "https://example.com/jobs/infra"
        })
      } as Response;
    });

    const adapter = createHiringAdapter({ maxItems: 1 });

    await expect(adapter.fetch()).resolves.toEqual([
      expect.objectContaining({
        content: expect.stringContaining("not affiliated"),
        metadata: expect.objectContaining({ source: "hackernews-jobs", type: "hiring" }),
        title: "ExampleCo is hiring infra engineers",
        url: "https://example.com/jobs/infra"
      })
    ]);
  });


  it("reads GitHub repository search results", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      expect(String(url)).toContain("search/repositories");
      expect(String(url)).toContain("topic%3Aai");
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              created_at: "2026-04-01T00:00:00Z",
              description: "Agent framework for local workflows",
              forks_count: 12,
              full_name: "example/agentkit",
              html_url: "https://github.com/example/agentkit",
              language: "TypeScript",
              pushed_at: "2026-04-25T00:00:00Z",
              stargazers_count: 1234,
              topics: ["ai", "agents"],
              updated_at: "2026-04-25T00:00:00Z"
            }
          ]
        })
      } as Response;
    });

    const adapter = createGitHubTrendingAdapter({ topic: "ai", maxItems: 1 });

    await expect(adapter.fetch()).resolves.toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ source: "github", stars: 1234 }),
        title: "example/agentkit",
        url: "https://github.com/example/agentkit"
      })
    ]);
  });

  it("reads Product Hunt posts when an API token is configured", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-token");
      return {
        ok: true,
        json: async () => ({
          data: {
            posts: {
              edges: [
                {
                  node: {
                    commentsCount: 7,
                    createdAt: "2026-04-25T00:00:00Z",
                    description: "Build agents from browser workflows.",
                    id: "post_1",
                    name: "AgentKit",
                    tagline: "Browser agents for builders",
                    topics: { edges: [{ node: { name: "AI" } }] },
                    url: "https://www.producthunt.com/posts/agentkit",
                    votesCount: 120,
                    website: "https://example.com/agentkit"
                  }
                }
              ]
            }
          }
        })
      } as Response;
    });

    const adapter = createProductHuntAdapter({ apiToken: "test-token", maxItems: 1 });

    await expect(adapter.fetch()).resolves.toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ source: "producthunt", votes: 120 }),
        title: "AgentKit: Browser agents for builders",
        url: "https://example.com/agentkit"
      })
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

  it("reads company RSS feeds", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => `
        <rss>
          <channel>
            <item>
              <title>New agent platform</title>
              <link>https://example.com/company-post</link>
              <description><![CDATA[Company post summary]]></description>
            </item>
          </channel>
        </rss>
      `
    } as Response);

    const adapter = createCompanyRssAdapter({ feeds: [{ name: "example", url: "https://example.com/rss.xml" }], maxItems: 1 });

    await expect(adapter.fetch()).resolves.toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ feedName: "example", source: "company-rss" }),
        title: "[example] New agent platform"
      })
    ]);
  });

  it("aggregates scoped sources without requiring keyword eligibility", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const value = String(url);
      if (/\/(topstories|beststories|newstories|showstories|askstories)\.json$/.test(value)) {
        return { ok: true, json: async () => [] } as Response;
      }
      if (value.includes("techcrunch.com")) {
        return {
          ok: true,
          text: async () => `
            <rss>
              <channel>
                <item>
                  <title>Founder interview from a quiet software company</title>
                  <link>https://techcrunch.com/founder-interview</link>
                  <description><![CDATA[A practical operating story without the preferred keyword list.]]></description>
                </item>
              </channel>
            </rss>
          `
        } as Response;
      }
      return { ok: false } as Response;
    });

    await expect(
      aggregateSources({ includeArxiv: false, includeReddit: false, includeTechCrunch: true, maxItems: 5 })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "techcrunch",
          title: "Founder interview from a quiet software company"
        })
      ])
    );
  });

  it("cools down empty aggregated sources after repeat zero-item runs", async () => {
    const now = new Date("2026-04-24T14:00:00.000Z");
    let hackerNewsFetches = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const value = String(url);
      if (value.endsWith("/topstories.json")) {
        hackerNewsFetches += 1;
        return { ok: true, json: async () => [] } as Response;
      }
      return { ok: false } as Response;
    });

    await aggregateSources({
      healthCooldownMs: 60_000,
      includeArxiv: false,
      includeCompanyRss: false,
      includeExpandedHackerNews: false,
      includeGitHub: false,
      includeHiring: false,
      includeProductHunt: false,
      includeReddit: false,
      includeTechCrunch: false,
      now
    });
    await aggregateSources({
      healthCooldownMs: 60_000,
      includeArxiv: false,
      includeCompanyRss: false,
      includeExpandedHackerNews: false,
      includeGitHub: false,
      includeHiring: false,
      includeProductHunt: false,
      includeReddit: false,
      includeTechCrunch: false,
      now: new Date("2026-04-24T14:01:00.000Z")
    });
    await aggregateSources({
      healthCooldownMs: 60_000,
      includeArxiv: false,
      includeCompanyRss: false,
      includeExpandedHackerNews: false,
      includeGitHub: false,
      includeHiring: false,
      includeProductHunt: false,
      includeReddit: false,
      includeTechCrunch: false,
      now: new Date("2026-04-24T14:01:30.000Z")
    });

    expect(hackerNewsFetches).toBe(2);
    expect(getAggregatedSourceHealth()).toEqual([
      expect.objectContaining({
        consecutiveFailures: 2,
        lastError: "No items returned",
        name: "hackernews",
        skippedUntil: "2026-04-24T14:02:00.000Z"
      })
    ]);
  });
});
