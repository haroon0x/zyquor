import type { SourceAdapter } from "@zyquor/adapters";
import type { DraftGenerationProvider } from "@zyquor/generation";
import { createSqliteRepository } from "@zyquor/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAutomaticIngest, draftFromSourcePacket, TopicDraftExistsError } from "./index.js";
import { cleanSentence, inferTweetTypeFromText, packetFieldsFromItem } from "./context.js";
import { analyzePostFeatures, validateSourcePostQuality } from "./quality.js";

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
  beforeEach(() => {
    process.env.ZYQUOR_QUALITY_MIN = "3";
  });

  afterEach(() => {
    delete process.env.ZYQUOR_QUALITY_MIN;
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
    const repository = await createSqliteRepository(":memory:");
    const adapter: SourceAdapter = {
      name: "test-hn",
      sourceType: "news",
      async fetch(metadata = {}) {
        return [
          {
            title: `HN: ${(metadata.topic as string | undefined) ?? "agents"}`,
            url: "https://news.ycombinator.com/item?id=1",
            metadata: { published: "2026-04-24T16:00:00.000Z" },
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
      "useful read: hn: automatic workers changes how teams think about automation."
    );
  });

  it("repairs source-backed generated text before auto-approve", async () => {
    const repository = await createSqliteRepository(":memory:");
    const adapter: SourceAdapter = {
      name: "article-news",
      sourceType: "news",
      async fetch() {
        return [
          {
            title: "Company blog explains safer AI agent failover",
            url: "https://example.com/database-failover",
            metadata: { published: "2026-04-24T16:00:00.000Z" },
            content:
              "The article explains safer failover defaults for AI agent operators. It includes specific recovery tradeoffs and rollout notes."
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

  it("rejects first-person ownership claims about third-party work", () => {
    const packet = {
      accountId: "account_personal",
      createdAt: "2026-04-24T15:00:00.000Z",
      facts: ["Acme shipped a faster SQLite build."],
      id: "packet_2",
      sourceType: "news" as const,
      status: "drafted" as const,
      summary: "Acme shipped a faster SQLite build.",
      title: "Acme ships faster SQLite",
      tweetType: "useful_info" as const,
      updatedAt: "2026-04-24T15:00:00.000Z",
      url: "https://example.com/acme-sqlite"
    };

    const misattributed = validateSourcePostQuality({
      packet,
      text: "We built the faster SQLite this weekend and cut our query time."
    });
    expect(misattributed.ok).toBe(false);
    expect(misattributed.reasons).toContain("first_person_misattribution");

    const clean = validateSourcePostQuality({
      packet,
      text: "Acme's faster SQLite build cut query time. Worth a look for local workloads."
    });
    expect(clean.reasons).not.toContain("first_person_misattribution");
    expect(clean.ok).toBe(true);
  });

  it("rejects mentions of other accounts on external-source posts", () => {
    const packet = {
      accountId: "account_personal",
      createdAt: "2026-04-24T15:00:00.000Z",
      facts: ["A maintainer demoed the new CLI."],
      id: "packet_3",
      sourceType: "news" as const,
      status: "drafted" as const,
      summary: "A maintainer demoed the new CLI.",
      title: "New CLI lands for local graph work",
      tweetType: "useful_info" as const,
      updatedAt: "2026-04-24T15:00:00.000Z",
      url: "https://example.com/cli"
    };

    const mentioned = validateSourcePostQuality({
      packet,
      text: "Check the new CLI that @sqlitebrowser shipped."
    });
    expect(mentioned.ok).toBe(false);
    expect(mentioned.reasons).toContain("account_mention_risk");

    const clean = validateSourcePostQuality({
      packet,
      text: "The new CLI cuts local graph setup to one command."
    });
    expect(clean.reasons).not.toContain("account_mention_risk");
    expect(clean.ok).toBe(true);
  });

  it("prioritizes broader preferred news signals during ingest", async () => {
    const repository = await createSqliteRepository(":memory:");
    const adapter: SourceAdapter = {
      name: "test-news",
      sourceType: "news",
      async fetch() {
        return [
          {
            title: "AI startup redesigns its blog",
            url: "https://example.com/celebrity-profile",
            metadata: { published: "2026-04-24T16:00:00.000Z" },
            content: "A startup announced a small redesign to its blog. The team mentioned using AI for the layout."
          },
          {
            title: "AI research team publishes language model benchmark with agent reliability gains",
            url: "https://example.com/battery-economy-research",
            metadata: { published: "2026-04-24T16:00:00.000Z" },
            content:
              "Researchers published a new paper on their language model, covering inference improvements, benchmark results, and agentic reliability gains for developers using the open source framework."
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
        title: "AI research team publishes language model benchmark with agent reliability gains"
      }
    ]);
  });

  it("filters low-quality sources before they enter the posting pipeline", async () => {
    const repository = await createSqliteRepository(":memory:");
    const adapter: SourceAdapter = {
      name: "quality-news",
      sourceType: "news",
      async fetch() {
        return [
          {
            title: "We built a deterministic AI agent router bypassing geopolitical supply chain chokeholds",
            url: "https://book.stripe.com/fZu5kCaBZ1JpaYTflPgEg05",
            metadata: { published: "2026-04-24T16:00:00.000Z" },
            content: "Payment link should never become an autopost source."
          },
          {
            title: "AI agent leaks credentials in memory as plaintext",
            url: "https://reddit.com/r/technology/comments/example",
            metadata: { published: "2026-04-24T16:00:00.000Z" },
            content: "AI agent leaks credentials in memory as plaintext"
          },
          {
            title: "Open source AI agent database release improves replication safety",
            url: "https://example.com/database-release",
            metadata: { published: "2026-04-24T16:00:00.000Z" },
            content:
              "The release adds safer replication defaults for AI agent workflows and distributed databases. Operators can reduce failover risk without adding a separate coordination service."
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

  it("skips generic how-to/guide and announcement titles before drafting", async () => {
    const repository = await createSqliteRepository(":memory:");
    const adapter: SourceAdapter = {
      name: "guide-news",
      sourceType: "news",
      async fetch() {
        return [
          {
            title: "A guide to slash commands in the GitHub Copilot app",
            url: "https://github.blog/ai-and-ml/guides/slash",
            metadata: { published: "2026-04-24T16:00:00.000Z" },
            content:
              "Slash commands turn a chat box into a workflow interface. Developers can plan work, collaborate in issues, automate tasks, and customize how the GitHub Copilot workflow runs in a project."
          },
          {
            title: "Trace-state replay cuts agent debugging time",
            url: "https://example.com/agent-trace-replay",
            metadata: { published: "2026-04-24T16:00:00.000Z" },
            content:
              "A traced reasoning state lets agent teams inspect and replay work step-by-step. The replay reduces the risk lateral failures pose to agentic workflows by preserving the control-plane state in an object store for later rollback."
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
      skippedByReason: { lowSignal: 1 },
      results: [{ url: "https://example.com/agent-trace-replay" }]
    });
    await expect(repository.getSourcePacketByUrl("https://github.blog/ai-and-ml/guides/slash", "account_personal")).resolves.toBeNull();
  });

  it("limits repeated GitHub posts in one day", async () => {
    process.env.ZYQUOR_MAX_GITHUB_POSTS_PER_DAY = "1";
    const repository = await createSqliteRepository(":memory:");
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
            metadata: { published: new Date(Date.now() - 3_600_000).toISOString() },
            content: "Language: TypeScript. Stars: 10000. Agent workflow repository."
          },
          {
            title: "Independent research lab publishes database benchmark",
            url: "https://example.org/database-benchmark",
            metadata: { published: new Date(Date.now() - 3_600_000).toISOString() },
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
      // Post history rows are stamped with the real clock under SQLite, so run
      // the ingest on today's date for the daily GitHub limit to see them.
      now: new Date(),
      repository
    });

    expect(result).toMatchObject({
      processed: 1,
      results: [{ url: "https://example.org/database-benchmark" }]
    });
    await expect(repository.getSourcePacketByUrl("https://github.com/new/github-agent", "account_personal")).resolves.toBeNull();
  });

  it("refuses to draft a second packet covering the same topic", async () => {
    const repository = await createSqliteRepository(":memory:");
    const packetA = await repository.createSourcePacket({
      accountId: "account_personal",
      sourceType: "news",
      title: "Celld SQLite sharding for Durable Objects launch",
      summary: "Celld ships sharding for Durable Objects.",
      facts: ["Celld uses SQLite sharding."],
      tweetType: "article_summary",
      url: "https://example.com/celld-a"
    });
    await draftFromSourcePacket({
      generationProvider: testProvider,
      packet: packetA,
      repository,
      options: { count: 1 }
    });

    const packetB = await repository.createSourcePacket({
      accountId: "account_personal",
      sourceType: "news",
      title: "Celld SQLite sharding for Durable Objects second look",
      summary: "Another take on Celld sharding.",
      facts: ["Celld object databases."],
      tweetType: "article_summary",
      url: "https://example.com/celld-b"
    });
    await expect(
      draftFromSourcePacket({
        generationProvider: testProvider,
        packet: packetB,
        repository,
        options: { count: 1 }
      })
    ).rejects.toThrow(TopicDraftExistsError);

    const packetC = await repository.createSourcePacket({
      accountId: "account_personal",
      sourceType: "news",
      title: "DeepSeek cuts pricing again",
      summary: "Pricing cut announcement.",
      facts: ["DeepSeek lowered prices."],
      tweetType: "article_summary",
      url: "https://example.com/deepseek"
    });
    await expect(
      draftFromSourcePacket({
        generationProvider: testProvider,
        packet: packetC,
        repository,
        options: { count: 1 }
      })
    ).resolves.toMatchObject({
      draft: { status: "created" }
    });

    const packets = await repository.listSourcePackets("account_personal");
    expect(packets.filter((packet) => packet.status === "drafted")).toHaveLength(2);
  });
});

describe("analyzePostFeatures", () => {
  it("freezes the features that later performance analysis needs", () => {
    const features = analyzePostFeatures("Prefix caching pays off 3x. https://x.com/a #perf");
    expect(features).toMatchObject({
      chars: expect.any(Number),
      words: 7,
      hasDigits: true,
      endsWithQuestion: false,
      linkCount: 1,
      hashtagCount: 1,
      opener: "prefix caching pays"
    });
  });

  it("detects question endings and digit-free posts", () => {
    expect(analyzePostFeatures("worth it?").endsWithQuestion).toBe(true);
    expect(analyzePostFeatures("no numbers here").hasDigits).toBe(false);
  });
});
