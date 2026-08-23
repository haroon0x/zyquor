import { createSqliteRepository } from "@zyquor/storage";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("draft candidate quality evaluation", () => {
  it("recomputes the deterministic quality score for every candidate without creating a job", async () => {
    const repository = await createSqliteRepository(":memory:");
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Show why SQLite can be enough.",
      candidates: [
        { text: "SQLite served 8 million rows from one $20 node.", score: { quality: 4 } },
        { text: "Sometimes simple databases are useful.", score: { quality: 1 } }
      ],
      metadata: { tweetType: "useful_info" }
    });
    const app = buildApp({ repository });

    const response = await app.inject({ method: "POST", url: `/drafts/${created.draft.id}/evaluate` });

    expect(response.statusCode).toBe(200);
    const candidates = response.json().candidates as Array<{ id: string; score: { quality: number } }>;
    expect(candidates).toHaveLength(2);
    // Deterministic score: the first post has a number and a specific noun, so it ranks above the vague one.
    expect(candidates[0]!.id).toBe(created.candidates[0]!.id);
    expect(candidates[0]!.score.quality).toBeGreaterThan(candidates[1]!.score.quality);
    await expect(repository.listJobs()).resolves.toEqual([]);
    await app.close();
  });

  it("returns 404 for a missing draft", async () => {
    const app = buildApp({ repository: await createSqliteRepository(":memory:") });
    const response = await app.inject({ method: "POST", url: "/drafts/does-not-exist/evaluate" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
