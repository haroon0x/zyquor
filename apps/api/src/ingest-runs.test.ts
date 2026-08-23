import type { SourceAdapter } from "@zyquor/adapters";
import type { DraftGenerationProvider } from "@zyquor/generation";
import { createSqliteRepository } from "@zyquor/storage";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const generationProvider: DraftGenerationProvider = {
  name: "ollama",
  model: "test-local",
  async generateDraftCandidates() {
    return [{ text: "Generated ingest draft", score: {} }];
  }
};

async function createConfig(app: ReturnType<typeof buildApp>) {
  const response = await app.inject({
    method: "POST",
    url: "/ingest-configs",
    payload: {
      accountId: "account_personal",
      sourceType: "news",
      maxPacketsPerDay: 5,
      tweetTypeMix: { useful_info: 100 },
      scheduleWindowStart: "00:00",
      scheduleWindowEnd: "23:59",
      enabled: true
    }
  });
  return response.json().config as { id: string };
}

describe("ingest run durability", () => {
  it("persists a succeeded async ingest run", async () => {
    const adapter: SourceAdapter = {
      name: "empty-news",
      sourceType: "news",
      async fetch() {
        return [];
      }
    };
    const app = buildApp({
      generationProvider,
      repository: await createSqliteRepository(":memory:"),
      sourceAdapters: [adapter]
    });
    const config = await createConfig(app);

    expect((await app.inject({ method: "POST", url: "/ingest-run/async" })).statusCode).toBe(202);
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: "/ingest-runs?accountId=account_personal" });
      expect(response.json().runs[0]).toMatchObject({
        configId: config.id,
        status: "succeeded",
        error: null,
        packetsCreated: 0
      });
    });

    await app.close();
  });

  it("persists a failed async ingest run", async () => {
    const adapter: SourceAdapter = {
      name: "failing-news",
      sourceType: "news",
      async fetch() {
        throw new Error("fetch failed");
      }
    };
    const app = buildApp({
      generationProvider,
      repository: await createSqliteRepository(":memory:"),
      sourceAdapters: [adapter]
    });
    const config = await createConfig(app);

    expect((await app.inject({ method: "POST", url: "/ingest-run/async" })).statusCode).toBe(202);
    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: "/ingest-runs?accountId=account_personal" });
      expect(response.json().runs[0]).toMatchObject({
        configId: config.id,
        status: "failed",
        error: "fetch failed",
        packetsCreated: 0
      });
    });

    await app.close();
  });

  it("marks interrupted ingest runs failed during recovery", async () => {
    const repository = await createSqliteRepository(":memory:");
    const run = await repository.createIngestRun({ configId: "ingest_config", accountId: "account_personal" });
    const app = buildApp({ generationProvider, repository, sourceAdapters: [] });

    const recovery = await app.inject({ method: "POST", url: "/ingest-runs/recover-stale" });
    expect(recovery.json()).toEqual({ recoveredCount: 1 });
    await expect(repository.listIngestRuns("account_personal")).resolves.toEqual([
      expect.objectContaining({ id: run.id, status: "failed", error: "interrupted", packetsCreated: 0 })
    ]);

    await app.close();
  });
});
