import type { SourceAdapter } from "@zyquor/adapters";
import type { DraftGenerationProvider } from "@zyquor/generation";
import { createMemoryRepository } from "@zyquor/storage";
import { describe, expect, it } from "vitest";
import { runAutomaticIngest } from "./index.js";

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
          tweetType: input.tweetType
        }
      }
    ];
  }
};

describe("automatic ingest", () => {
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
      mediaUrls: ["https://example.com/news.png"]
    });
  });
});
