import type { EvaluateTweetQualityInput, EvaluateTweetQualityOptions, TweetQualityEvaluation } from "@zyquor/generation";
import { createMemoryRepository } from "@zyquor/storage";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("draft candidate quality evaluation", () => {
  it("stores advisory Ollama results on every candidate without creating a job", async () => {
    const repository = createMemoryRepository();
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Show why SQLite can be enough.",
      candidates: [
        { text: "SQLite served 8 million rows from one $20 node.", score: { quality: 4 } },
        { text: "Sometimes simple databases are useful.", score: { quality: 1 } }
      ],
      metadata: { tweetType: "useful_info" }
    });
    const calls: Array<{ input: EvaluateTweetQualityInput; options: EvaluateTweetQualityOptions | undefined }> = [];
    const results: TweetQualityEvaluation[] = [
      { score: 9, verdict: "strong", reasons: ["Concrete number"] },
      { score: 3, verdict: "weak", reasons: ["Generic opening"] }
    ];
    const app = buildApp({
      repository,
      generationEnv: {
        ZYQUOR_OLLAMA_BASE_URL: "http://ollama.test:11434",
        ZYQUOR_OLLAMA_MODEL: "local-judge"
      },
      async tweetQualityEvaluator(input, options) {
        calls.push({ input, options });
        return results[calls.length - 1]!;
      }
    });

    const response = await app.inject({ method: "POST", url: `/drafts/${created.draft.id}/evaluate` });

    expect(response.statusCode).toBe(200);
    expect(calls).toEqual([
      {
        input: {
          text: "SQLite served 8 million rows from one $20 node.",
          tweetType: "useful_info",
          idea: "Show why SQLite can be enough."
        },
        options: { baseUrl: "http://ollama.test:11434", model: "local-judge" }
      },
      {
        input: {
          text: "Sometimes simple databases are useful.",
          tweetType: "useful_info",
          idea: "Show why SQLite can be enough."
        },
        options: { baseUrl: "http://ollama.test:11434", model: "local-judge" }
      }
    ]);
    expect(response.json().candidates).toEqual([
      expect.objectContaining({
        id: created.candidates[0]?.id,
        score: expect.objectContaining({
          quality: 4,
          judgeScore: 9,
          judgeVerdict: "strong",
          judgeReasons: ["Concrete number"],
          judgedAt: expect.any(String),
          judgeModel: "local-judge"
        })
      }),
      expect.objectContaining({
        id: created.candidates[1]?.id,
        score: expect.objectContaining({
          quality: 1,
          judgeScore: 3,
          judgeVerdict: "weak",
          judgeReasons: ["Generic opening"],
          judgedAt: expect.any(String),
          judgeModel: "local-judge"
        })
      })
    ]);
    await expect(repository.listJobs()).resolves.toEqual([]);
    await app.close();
  });

  it("returns 503 and stores nothing when the local judge is unreachable", async () => {
    const repository = createMemoryRepository();
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Keep evaluation local.",
      candidates: [{ text: "Local evaluation keeps unpublished drafts private.", score: { quality: 3 } }]
    });
    const app = buildApp({
      repository,
      async tweetQualityEvaluator() {
        throw new TypeError("fetch failed");
      }
    });

    const response = await app.inject({ method: "POST", url: `/drafts/${created.draft.id}/evaluate` });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "Local Ollama quality judge failed: fetch failed" });
    await expect(repository.getDraft(created.draft.id)).resolves.toEqual(created);
    await app.close();
  });
});
