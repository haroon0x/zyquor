import { createSqliteRepository } from "@zyquor/storage";
import type { DraftGenerationProvider, GenerateDraftCandidatesInput } from "@zyquor/generation";
import type { GoldfishContextBundle, GoldfishContextInput } from "@zyquor/adapters";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const fetchedTweet = {
  id: "1898765432109876543",
  authorHandle: "target_user",
  authorName: "Target User",
  text: "Nobody reads raw audit logs except auditors.",
  url: "https://x.com/target_user/status/1898765432109876543",
  publishedAt: "2026-10-25T10:00:00.000Z",
  isRetweet: false
};

const memoryBundle = (): GoldfishContextBundle => ({
  terms: ["target_user", "audit"],
  wiki: [{ slug: "acme-labs", title: "Acme Labs", type: "company", summary: "Developer tooling." }],
  memories: [{ app: "vscode", capturedAt: "2026-10-20T09:15:00.000Z", title: "audit work", excerpt: "Shipped log viewer." }]
});

function testProvider(inputs: GenerateDraftCandidatesInput[]): DraftGenerationProvider {
  return {
    name: "ollama",
    model: "test-local",
    async generateDraftCandidates(input) {
      inputs.push(input);
      return [{ text: "A concrete, opinionated reply about audit logs.", score: { quality: 5 } }];
    }
  };
}

async function buildTestApp(options: {
  inputs: GenerateDraftCandidatesInput[];
  goldfishReplyContext?: (input: GoldfishContextInput) => Promise<GoldfishContextBundle | null>;
}) {
  const fetchTweet = vi.fn(async () => ({ tweet: fetchedTweet, url: fetchedTweet.url }));
  const goldfish = options.goldfishReplyContext ?? (async () => memoryBundle());
  const app = buildApp({
    repository: await createSqliteRepository(":memory:"),
    generationProvider: testProvider(options.inputs),
    fetchTweet,
    goldfishReplyContext: goldfish
  });
  return { app, goldfish };
}

const replyUrl = "https://x.com/target_user/status/1898765432109876543";

describe("reply memory grounding", () => {
  it("records applied memory in the response, draft metadata, and prompt", async () => {
    const inputs: GenerateDraftCandidatesInput[] = [];
    const goldfish = vi.fn(async () => memoryBundle());
    const { app } = await buildTestApp({ inputs, goldfishReplyContext: goldfish });

    const response = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId: "account_personal", url: replyUrl }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.memory).toEqual({
      used: true,
      terms: ["target_user", "audit"],
      wikiCount: 1,
      memoryCount: 1
    });
    expect(goldfish).toHaveBeenCalledTimes(1);
    const metadata = body.draft.metadata as { memory?: Record<string, unknown> };
    expect(metadata.memory).toMatchObject({
      terms: ["target_user", "audit"],
      wikiTitles: ["Acme Labs"],
      memories: ["audit work"],
      wikiCount: 1,
      memoryCount: 1
    });
    expect(inputs[0]?.memoryContext).toContain("- Wiki [company] Acme Labs: Developer tooling.");
    expect(inputs[0]?.memoryContext).not.toContain("<personal-memory>"); // the tag is added in the prompt layer
    expect(inputs[0]?.replyContext?.authorHandle).toBe("target_user");
  });

  it("degrades to unavailable and never fails the request", async () => {
    const inputs: GenerateDraftCandidatesInput[] = [];
    const goldfish = vi.fn(async () => null);
    const { app } = await buildTestApp({ inputs, goldfishReplyContext: goldfish });

    const response = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId: "account_personal", url: replyUrl, useMemory: true }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().memory).toEqual({ used: false, reason: "unavailable" });
    const metadata = response.json().draft.metadata as { memory?: Record<string, unknown> };
    expect(metadata.memory).toBeUndefined();
    expect(inputs[0]?.memoryContext).toBeUndefined();
  });

  it("reports empty when goldfish finds nothing for the author", async () => {
    const inputs: GenerateDraftCandidatesInput[] = [];
    const goldfish = vi.fn(async () => ({ terms: ["target_user"], wiki: [], memories: [] }));
    const { app } = await buildTestApp({ inputs, goldfishReplyContext: goldfish });

    const response = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId: "account_personal", url: replyUrl, useMemory: true }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().memory).toEqual({ used: false, reason: "empty" });
    expect(inputs[0]?.memoryContext).toBeUndefined();
  });

  it("honors useMemory: false without calling goldfish", async () => {
    const inputs: GenerateDraftCandidatesInput[] = [];
    const goldfish = vi.fn(async () => memoryBundle());
    const { app } = await buildTestApp({ inputs, goldfishReplyContext: goldfish });

    const response = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId: "account_personal", url: replyUrl, useMemory: false }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().memory).toEqual({ used: false, reason: "disabled" });
    expect(goldfish).not.toHaveBeenCalled();
    expect(inputs[0]?.memoryContext).toBeUndefined();
  });

  it("falls back to the account's style rules.replyMemory default", async () => {
    const inputs: GenerateDraftCandidatesInput[] = [];
    const repository = await createSqliteRepository(":memory:");
    await repository.updateStyleProfile("style_default", { rules: { replyMemory: false } });
    const goldfish = vi.fn(async () => memoryBundle());
    const app = buildApp({
      repository,
      generationProvider: testProvider(inputs),
      fetchTweet: vi.fn(async () => ({ tweet: fetchedTweet, url: fetchedTweet.url })),
      goldfishReplyContext: goldfish
    });
    const disabled = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId: "account_personal", url: replyUrl }
    });
    expect(disabled.json().memory).toEqual({ used: false, reason: "disabled" });
    expect(goldfish).not.toHaveBeenCalled();

    // An explicit request body flag always wins over the rule.
    const forced = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId: "account_personal", url: replyUrl, useMemory: true }
    });
    expect(forced.json().memory).toEqual({ used: true, terms: ["target_user", "audit"], wikiCount: 1, memoryCount: 1 });
    expect(goldfish).toHaveBeenCalledTimes(1);
  });

  it("defaults memory on when no rule says otherwise", async () => {
    const inputs: GenerateDraftCandidatesInput[] = [];
    const goldfish = vi.fn(async () => memoryBundle());
    const { app } = await buildTestApp({ inputs, goldfishReplyContext: goldfish });

    const response = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId: "account_personal", url: replyUrl }
    });

    expect(response.json().memory).toEqual({ used: true, terms: ["target_user", "audit"], wikiCount: 1, memoryCount: 1 });
    expect(goldfish).toHaveBeenCalledTimes(1);
  });
});
