import type { SourceAdapter } from "@zyquor/adapters";
import type { DraftGenerationProvider } from "@zyquor/generation";
import { createMemoryRepository } from "@zyquor/storage";
import { afterEach, describe, expect, it } from "vitest";
import { runAutomaticIngest } from "./index.js";
import { cleanSentence, inferTweetTypeFromText, packetFieldsFromItem } from "./context.js";
import { validateSourcePostQuality } from "./quality.js";

const testProvider: DraftGenerationProvider = {
  name: "ollama",
  model: "test",
  async generateDraftCandidates(input) {
    return [
      {
        text: `Useful read: ${input.context?.title ?? "source"} changes how teams think about automation.`,
        score: {
          provider: "test",
          hasSourceContext: Boolean(input.context?.facts?.length),
          tweetType: input.tweetType,
          quality: 3
        }
      }
    ];
  }
};

describe("automatic ingest", () => {
  afterEach(() => {
    delete process.env.ZYQUOR_MAX_GITHUB_POSTS_PER_DAY;
    delete process.env.ZYQUOR_MAX_SAME_HOST_POSTS_PER_DAY;
  });

  it("cleans HTML entities and escaped URLs from source text", () => {
    expect(cleanSentence("Voi founders&#8217; AI startup &amp; funding")).toBe("Voi founders' AI startup & funding");
    expect(cleanSentence("https:\\/\\/example.com\\/article")).toBe("https://example.com/article");
    expect(
      packetFieldsFromItem({
        title: "Voi founders&#8217; new AI startup",
        url: "https://example.com/article",
        content: "Funding summary with Reuters&#8217; details. https:\\/\\/example.com\\/article"
      })
    ).toMatchObject({
      title: "Voi founders' new AI startup",
      summary: "Funding summary with Reuters' details.",
      facts: ["Voi founders' new AI startup", "Funding summary with Reuters' details."]
    });
  });

  it("routes hiring and company blog sources to specialized tweet types", () => {
    expect(
      inferTweetTypeFromText({
        title: "ExampleCo is hiring infra engineers",
        url: "https://example.com/jobs",
        content: "Verified hiring source.",
        metadata: { source: "hackernews-jobs", type: "hiring" }
      })
    ).toBe("hiring");

    expect(
      inferTweetTypeFromText({
        title: "New agent platform architecture",
        url: "https://example.com/blog/agents",
        content: "A company blog explains browser agents.",
        metadata: { source: "company-rss" }
      })
    ).toBe("article_summary");
  });

  it("turns source items into packets, generated drafts, and autopost jobs", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const adapter: SourceAdapter = {
      name: "test-hn",
      sourceType: "news",
      async fetch(metadata = {}) {
        return [
          {
            title: `HN: ${(metadata.topic as string | undefined) ?? "agents"}`,
            url: "https://news.ycombinator.com/item?id=1",
            content: "A real Hacker News discussion about automatic workers, LLM context, and posting pipelines.",
            imageUrl: "https://example.com/news.png"
          }
        ];
      }
    };
    await repository.createIngestConfig({
      accountId: "account_personal",
      enabled: true,
      maxPacketsPerDay: 3,
      metadata: { topic: "automatic workers" },
      scheduleWindowEnd: "23:59",
      scheduleWindowStart: "00:00",
      sourceType: "news",
      tweetTypeMix: { news_context: 100 }
    });

    const result = await runAutomaticIngest({
      adapters: new Map([["news", adapter]]),
      generationProvider: testProvider,
      now: new Date("2026-04-24T17:00:00.000Z"),
      repository
    });

    expect(result).toMatchObject({
      errors: [],
      processed: 1,
      results: [{ sourceType: "news", url: "https://news.ycombinator.com/item?id=1" }]
    });
    await expect(repository.listSourcePackets("account_personal")).resolves.toMatchObject([
      {
        status: "drafted",
        title: "HN: automatic workers",
        tweetType: "news_context"
      }
    ]);
    const jobs = await repository.listJobs();
    expect(jobs).toMatchObject([{ mode: "autopost", status: "approved" }]);
    const draft = await repository.getDraft(jobs[0]!.draftId);
    expect(draft?.draft.metadata).toMatchObject({
      mediaUrls: ["https://example.com/news.png"],
      sourcePacketId: result.results[0]!.packetId,
      sourceType: "news",
      tweetType: "news_context"
    });
    expect(draft?.candidates).toEqual([]);
    expect(draft?.draft.editedText).toBe(
      "useful read: hn: automatic workers changes how teams think about automation. https://news.ycombinator.com/item?id=1"
    );
  });

  it("repairs source-backed generated text before auto-approve", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const adapter: SourceAdapter = {
      name: "article-news",
      sourceType: "news",
      async fetch() {
        return [
          {
            title: "Company blog explains safer database failover",
            url: "https://example.com/database-failover",
            content:
              "The article explains safer database failover defaults for operators. It includes specific recovery tradeoffs and rollout notes."
          }
        ];
      }
    };
    const provider: DraftGenerationProvider = {
      name: "ollama",
      model: "test",
      async generateDraftCandidates() {
        return [
          {
            text: "> old failover was brittle > new defaults reduce operator risk",
            score: { quality: 3 }
          }
        ];
      }
    };
    await repository.createIngestConfig({
      accountId: "account_personal",
      enabled: true,
      maxPacketsPerDay: 1,
      metadata: {},
      scheduleWindowEnd: "23:59",
      scheduleWindowStart: "00:00",
      sourceType: "news",
      tweetTypeMix: { article_summary: 100 }
    });

    await runAutomaticIngest({
      adapters: new Map([["news", adapter]]),
      generationProvider: provider,
      now: new Date("2026-04-24T17:00:00.000Z"),
      repository
    });

    const jobs = await repository.listJobs();
    const draft = await repository.getDraft(jobs[0]!.draftId);
    expect(draft?.draft.editedText).toBe(
      "> old failover was brittle\n> new defaults reduce operator risk\nhttps://example.com/database-failover"
    );
  });

  it("blocks immediate second post from the same source packet", () => {
    const packet = {
      accountId: "account_personal",
      createdAt: "2026-04-24T15:00:00.000Z",
      facts: ["Show HN: local database tool", "Tool adds reproducible local graph queries."],
      id: "packet_1",
      sourceType: "news" as const,
      status: "drafted" as const,
      summary: "Tool adds reproducible local graph queries.",
      title: "Show HN: local database tool",
      tweetType: "useful_info" as const,
      updatedAt: "2026-04-24T15:00:00.000Z",
      url: "https://example.com/local-db"
    };

    const result = validateSourcePostQuality({
      history: [
        {
          accountId: "account_personal",
          draftId: "draft_1",
          id: "history_1",
          metadata: {},
          postedAt: "2026-04-24T16:30:00.000Z",
          postedText: "First angle.",
          postUrl: "https://x.com/example/status/1",
          sourcePacketId: "packet_1",
          sourceTitle: packet.title,
          sourceType: "news",
          sourceUrl: packet.url,
          tweetType: "useful_info"
        }
      ],
      now: new Date("2026-04-24T17:00:00.000Z"),
      packet,
      text: "Second angle."
    });

    expect(result).toMatchObject({
      ok: false,
      reasons: ["same_source_packet_cooldown"]
    });
  });

  it("prioritizes broader preferred news signals during ingest", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const adapter: SourceAdapter = {
      name: "test-news",
      sourceType: "news",
      async fetch() {
        return [
          {
            title: "Celebrity profile gets a redesign",
            url: "https://example.com/celebrity-profile",
            content: "A lifestyle site changed its homepage layout."
          },
          {
            title: "Science team publishes battery research with economy impact",
            url: "https://example.com/battery-economy-research",
            content:
              "Researchers published a new paper on battery storage, energy supply chains, and inflation pressure."
          }
        ];
      }
    };
    await repository.createIngestConfig({
      accountId: "account_personal",
      enabled: true,
      maxPacketsPerDay: 1,
      metadata: {},
      scheduleWindowEnd: "23:59",
      scheduleWindowStart: "00:00",
      sourceType: "news",
      tweetTypeMix: { useful_info: 100 }
    });

    const result = await runAutomaticIngest({
      adapters: new Map([["news", adapter]]),
      generationProvider: testProvider,
      now: new Date("2026-04-24T17:00:00.000Z"),
      repository
    });

    expect(result).toMatchObject({
      errors: [],
      processed: 1,
      results: [{ url: "https://example.com/battery-economy-research" }]
    });
    await expect(repository.listSourcePackets("account_personal")).resolves.toMatchObject([
      {
        title: "Science team publishes battery research with economy impact"
      }
    ]);
  });

  it("skips already posted source URLs and continues after one bad generated item", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const postedDraft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Posted source",
      candidates: [{ text: "Previously posted source", score: {} }]
    });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: postedDraft.draft.id,
      postedText: "Previously posted source",
      postUrl: "https://x.com/example/status/1",
      sourceUrl: "https://example.com/already-posted"
    });
    const adapter: SourceAdapter = {
      name: "test-news",
      sourceType: "news",
      async fetch() {
        return [
          {
            title: "Already posted source",
            url: "https://example.com/already-posted",
            content: "AI source that should not be posted twice."
          },
          {
            title: "Bad generated source",
            url: "https://example.com/bad-generated",
            content: "AI source that will generate an invalid long tweet."
          },
          {
            title: "Good generated source",
            url: "https://example.com/good-generated",
            content: "AI source that should still be queued after a bad item."
          }
        ];
      }
    };
    let generateCount = 0;
    const provider: DraftGenerationProvider = {
      name: "ollama",
      model: "test",
      async generateDraftCandidates() {
        generateCount += 1;
        return [
          {
            text: generateCount === 1 ? "x".repeat(281) : "Good generated source is useful.",
            score: { quality: 3 }
          }
        ];
      }
    };
    await repository.createIngestConfig({
      accountId: "account_personal",
      enabled: true,
      maxPacketsPerDay: 2,
      metadata: {},
      scheduleWindowEnd: "23:59",
      scheduleWindowStart: "00:00",
      sourceType: "news",
      tweetTypeMix: { useful_info: 100 }
    });

    const result = await runAutomaticIngest({
      adapters: new Map([["news", adapter]]),
      generationProvider: provider,
      now: new Date("2026-04-24T17:00:00.000Z"),
      repository
    });

    expect(result.processed).toBe(1);
    expect(result.results).toMatchObject([{ url: "https://example.com/good-generated" }]);
    expect(result.errors[0]?.error).toContain("Post text exceeds 280 characters");
    await expect(repository.getSourcePacketByUrl("https://example.com/already-posted", "account_personal")).resolves.toBeNull();
    await expect(repository.getSourcePacketByUrl("https://example.com/bad-generated", "account_personal")).resolves.toBeNull();
  });

  it("filters low-quality sources before they enter the posting pipeline", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const adapter: SourceAdapter = {
      name: "quality-news",
      sourceType: "news",
      async fetch() {
        return [
          {
            title: "We built deterministic routing enginebypass geopolitical supply chain chokeholds",
            url: "https://book.stripe.com/fZu5kCaBZ1JpaYTflPgEg05",
            content: "Payment link should never become an autopost source."
          },
          {
            title: "Microsoft Edge: Passwords end up in memory as plaintext",
            url: "https://reddit.com/r/technology/comments/example",
            content: "Microsoft Edge: Passwords end up in memory as plaintext"
          },
          {
            title: "Open source database release improves replication safety",
            url: "https://example.com/database-release",
            content:
              "The release adds safer replication defaults for distributed databases. Operators can reduce failover risk without adding a separate coordination service."
          }
        ];
      }
    };
    await repository.createIngestConfig({
      accountId: "account_personal",
      enabled: true,
      maxPacketsPerDay: 3,
      metadata: {},
      scheduleWindowEnd: "23:59",
      scheduleWindowStart: "00:00",
      sourceType: "news",
      tweetTypeMix: { useful_info: 100 }
    });

    const result = await runAutomaticIngest({
      adapters: new Map([["news", adapter]]),
      generationProvider: testProvider,
      now: new Date("2026-04-24T17:00:00.000Z"),
      repository
    });

    expect(result).toMatchObject({
      errors: [],
      processed: 1,
      results: [{ url: "https://example.com/database-release" }]
    });
    await expect(repository.getSourcePacketByUrl("https://book.stripe.com/fZu5kCaBZ1JpaYTflPgEg05", "account_personal")).resolves.toBeNull();
    await expect(repository.getSourcePacketByUrl("https://reddit.com/r/technology/comments/example", "account_personal")).resolves.toBeNull();
  });

  it("limits repeated GitHub posts in one day", async () => {
    process.env.ZYQUOR_MAX_GITHUB_POSTS_PER_DAY = "1";
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const postedDraft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "GitHub posted",
      candidates: [{ text: "GitHub posted text", score: {} }]
    });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: postedDraft.draft.id,
      postedText: "GitHub posted text",
      postUrl: "https://x.com/example/status/2",
      sourceTitle: "Existing GitHub agent repo",
      sourceUrl: "https://github.com/example/existing"
    });
    const adapter: SourceAdapter = {
      name: "github-heavy",
      sourceType: "news",
      async fetch() {
        return [
          {
            title: "new/github-agent: agent workflow repository",
            url: "https://github.com/new/github-agent",
            content: "Language: TypeScript. Stars: 10000. Agent workflow repository."
          },
          {
            title: "Independent research lab publishes database benchmark",
            url: "https://example.org/database-benchmark",
            content:
              "The benchmark compares database replication behavior under network partitions. It includes reproducible scripts and notes on operator tradeoffs."
          }
        ];
      }
    };
    await repository.createIngestConfig({
      accountId: "account_personal",
      enabled: true,
      maxPacketsPerDay: 3,
      metadata: {},
      scheduleWindowEnd: "23:59",
      scheduleWindowStart: "00:00",
      sourceType: "news",
      tweetTypeMix: { useful_info: 100 }
    });

    const result = await runAutomaticIngest({
      adapters: new Map([["news", adapter]]),
      generationProvider: testProvider,
      now: new Date("2026-04-24T17:00:00.000Z"),
      repository
    });

    expect(result).toMatchObject({
      processed: 1,
      results: [{ url: "https://example.org/database-benchmark" }]
    });
    await expect(repository.getSourcePacketByUrl("https://github.com/new/github-agent", "account_personal")).resolves.toBeNull();
  });
});
