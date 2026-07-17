import { createMemoryRepository } from "@zyquor/storage";
import type { DraftGenerationProvider } from "@zyquor/generation";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const generationProvider: DraftGenerationProvider = {
  name: "ollama",
  model: "test-local",
  async generateDraftCandidates() {
    return [];
  }
};

describe("quality gate failure drafts", () => {
  it("returns rejected drafts with candidates and quality gate metadata", async () => {
    const repository = createMemoryRepository({ now: () => "2026-07-17T09:00:00.000Z" });
    const qualityGate = {
      bestQuality: 2,
      threshold: 3,
      slopPhrase: null,
      reason: "all_below_quality_floor",
      rejectedAt: "2026-07-17T09:01:00.000Z"
    };
    const rejected = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Quality gate rejection",
      candidates: [{ text: "A candidate that needs review.", score: { quality: 2 } }],
      metadata: { qualityGate }
    });
    const app = buildApp({ generationProvider, repository });

    const response = await app.inject({ method: "GET", url: "/drafts/quality-gate-failures" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      drafts: [
        {
          draft: expect.objectContaining({ id: rejected.draft.id, status: "selected" }),
          candidates: rejected.candidates,
          qualityGate
        }
      ]
    });
    await app.close();
  });
});
