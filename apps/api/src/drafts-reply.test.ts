import { createMemoryRepository } from "@zyquor/storage";
import type { DraftGenerationProvider, GenerateDraftCandidatesInput } from "@zyquor/generation";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const replyTo = {
  tweetId: "1898765432109876543",
  authorHandle: "target_user",
  url: "https://x.com/target_user/status/1898765432109876543"
};

describe("reply drafts", () => {
  it("creates and generates a reply draft, then carries the target to approval", async () => {
    const generationInputs: GenerateDraftCandidatesInput[] = [];
    const generationProvider: DraftGenerationProvider = {
      name: "ollama",
      model: "test-local",
      async generateDraftCandidates(input) {
        generationInputs.push(input);
        return [{ text: "a useful reply grounded in the user's description.", score: { quality: 5 } }];
      }
    };
    const app = buildApp({
      generationProvider,
      repository: createMemoryRepository({ now: () => "2026-07-15T12:00:00.000Z" })
    });

    const created = await app.inject({
      method: "POST",
      url: "/drafts",
      payload: {
        accountId: "account_personal",
        idea: "The target post argues that local tools need visible audit trails.",
        replyToUrl: replyTo.url,
        tweetType: "opinion",
        yolo: false,
        autopost: false
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().draft).toMatchObject({
      replyTo,
      metadata: { tweetType: "reply" }
    });

    const generated = await app.inject({
      method: "POST",
      url: `/drafts/${created.json().draft.id}/generate`
    });

    expect(generated.statusCode).toBe(201);
    expect(generationInputs).toHaveLength(1);
    expect(generationInputs[0]).toMatchObject({
      tweetType: "reply",
      replyContext: { authorHandle: replyTo.authorHandle, url: replyTo.url }
    });

    const selected = await app.inject({
      method: "POST",
      url: `/drafts/${created.json().draft.id}/select`,
      payload: {
        candidateId: generated.json().candidates[0].id,
        editedText: "a useful reply grounded in the user's description."
      }
    });

    expect(selected.statusCode).toBe(200);
    expect(selected.json().draft).toMatchObject({ replyTo });

    const approved = await app.inject({
      method: "POST",
      url: `/drafts/${created.json().draft.id}/approve`,
      payload: { editedText: "a useful reply grounded in the user's description." }
    });

    expect(approved.statusCode).toBe(201);
    expect(approved.json().job).toMatchObject({ replyTo });
  });

  it("rejects a non-post reply URL with a clear 400 response", async () => {
    const app = buildApp({ repository: createMemoryRepository() });

    const response = await app.inject({
      method: "POST",
      url: "/drafts",
      payload: {
        accountId: "account_personal",
        idea: "Reply to this post.",
        replyToUrl: "https://example.com/target_user/status/1898765432109876543"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "replyToUrl must be a valid x.com or twitter.com post URL" });
  });
});
