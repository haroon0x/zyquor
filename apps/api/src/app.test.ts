import { createMemoryRepository } from "@zyquor/storage";
import type { SourceAdapter } from "@zyquor/adapters";
import type { DraftGenerationProvider } from "@zyquor/generation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const testNewsAdapter: SourceAdapter = {
  name: "test-news",
  sourceType: "news",
  async fetch() {
    return [
      {
        title: "TypeScript 6.0: The Future of Static Typing",
        url: "https://dev.to/typescript/ts-6-preview",
        content:
          "TypeScript 6.0 introduces higher-order type guards and improved recursive type inference. This release focuses on developer productivity and large codebase performance."
      },
      {
        title: "Playwright v2.0: Native Mobile Emulation",
        url: "https://playwright.dev/blog/v2-roadmap",
        content:
          "Playwright v2.0 focuses on native mobile emulation, multi-page debugging in a single trace, and a unified API for cross-device testing."
      },
      {
        title: "YC Hacker News: The Future of AI Agents",
        url: "https://news.ycombinator.com/item?id=40000000",
        content:
          "Hacker News discussion on autonomous agentic workflows and persistent background-running agents that handle complex pipelines."
      }
    ];
  }
};

const testGenerationProvider: DraftGenerationProvider = {
  name: "ollama",
  model: "test-local",
  async generateDraftCandidates(input) {
    const count = Math.max(1, Math.min(input.count ?? 3, 5));
    return Array.from({ length: count }, (_, index) => ({
      text: `${input.idea.trim()} Test candidate ${index + 1}.`.slice(0, 240),
      score: { provider: "test", rank: index + 1, quality: 5 }
    }));
  }
};

describe("api workflow", () => {
  it("generates, approves, and dry-run prepares a job", async () => {
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      })
    });

    const draftResponse = await app.inject({
      method: "POST",
      url: "/drafts",
      payload: {
        accountId: "account_personal",
        idea: "Make local automation auditable."
      }
    });

    expect(draftResponse.statusCode).toBe(201);
    const draftBody = draftResponse.json();

    const accountResponse = await app.inject({
      method: "PATCH",
      url: "/accounts/account_personal",
      payload: {
        displayName: "Personal",
        profileDir: "profiles/personal-main",
        postingMode: "prepare_only",
        enabled: true
      }
    });

    expect(accountResponse.statusCode).toBe(200);
    expect(accountResponse.json()).toMatchObject({
      account: {
        displayName: "Personal"
      }
    });

    const approveResponse = await app.inject({
      method: "POST",
      url: `/drafts/${draftBody.draft.id}/approve`,
      payload: {
        editedText: "Make local automation auditable."
      }
    });

    expect(approveResponse.statusCode).toBe(201);
    const approveBody = approveResponse.json();

    const prepareResponse = await app.inject({
      method: "POST",
      url: `/jobs/${approveBody.job.id}/prepare`
    });

    expect(prepareResponse.statusCode).toBe(200);
    expect(prepareResponse.json()).toMatchObject({
      dryRun: true,
      job: {
        status: "prepared"
      }
    });

    const postResponse = await app.inject({
      method: "POST",
      url: `/jobs/${approveBody.job.id}/post`
    });

    expect(postResponse.statusCode).toBe(403);

    await app.close();
  });

  it("reports configured generation provider", async () => {
    const app = buildApp({
      generationEnv: {
        ZYQUOR_LLM_PROVIDER: "ollama",
        ZYQUOR_OLLAMA_MODEL: "llama3.1:8b",
        ZYQUOR_OLLAMA_BASE_URL: "http://127.0.0.1:11434"
      },
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      })
    });

    const healthResponse = await app.inject({ method: "GET", url: "/health" });
    expect(healthResponse.json()).toMatchObject({
      ok: true,
      generation: {
        provider: "ollama",
        model: "llama3.1:8b"
      }
    });

    const generationResponse = await app.inject({ method: "GET", url: "/generation" });
    expect(generationResponse.json()).toMatchObject({
      generation: {
        provider: "ollama",
        model: "llama3.1:8b",
        configured: true
      }
    });

    await app.close();
  });

  it("updates generation provider and model", async () => {
    const app = buildApp({
      generationEnv: {
        ZYQUOR_LLM_PROVIDER: "ollama",
        ZYQUOR_OLLAMA_MODEL: "llama3.1:8b"
      },
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      })
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/generation",
      payload: {
        provider: "ollama",
        model: "qwen2.5:7b"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      generation: {
        provider: "ollama",
        model: "qwen2.5:7b",
        configured: true
      }
    });

    const healthResponse = await app.inject({ method: "GET", url: "/health" });
    expect(healthResponse.json()).toMatchObject({
      generation: {
        provider: "ollama",
        model: "qwen2.5:7b"
      }
    });

    await app.close();
  });

  it("updates style prompt configuration", async () => {
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      })
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/style-profiles/style_default",
      payload: {
        bannedPhrases: ["cheap bait"],
        rules: {
          objective: "Grow useful reach with sharp, grounded posts.",
          systemPromptExtra: "Use tasteful tension when true."
        },
        tone: "clear, sharp, useful"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      profile: {
        bannedPhrases: ["cheap bait"],
        rules: {
          objective: "Grow useful reach with sharp, grounded posts.",
          systemPromptExtra: "Use tasteful tension when true."
        },
        tone: "clear, sharp, useful"
      }
    });

    await app.close();
  });

  it("reports the browser X session for the configured account", async () => {
    const app = buildApp({
      browserCdpUrl: "http://127.0.0.1:9222",
      checkXLogin: async (input) => ({
        loggedIn: input.profileDir.endsWith("profiles/personal-main"),
        url: "https://x.com/home"
      }),
      enableBrowserPrepare: true,
      generationProvider: testGenerationProvider,
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      })
    });

    const response = await app.inject({
      method: "GET",
      url: "/browser/x-session?accountId=account_personal"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accountId: "account_personal",
      cdpUrl: "http://127.0.0.1:9222",
      enabled: true,
      error: null,
      loggedIn: true,
      profileDir: expect.stringContaining("profiles/personal-main"),
      url: "https://x.com/home"
    });

    await app.close();
  });

  it("stores scheduled approvals and blocks prepare before schedule time", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const app = buildApp({ repository, generationProvider: testGenerationProvider });
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Scheduled idea",
      candidates: [{ text: "Scheduled value post", score: {} }]
    });
    const scheduledFor = "2999-04-25T15:30:00.000Z";

    const approveResponse = await app.inject({
      method: "POST",
      url: `/drafts/${created.draft.id}/approve`,
      payload: {
        editedText: "Scheduled value post",
        mode: "scheduled",
        scheduledFor
      }
    });

    expect(approveResponse.statusCode).toBe(201);
    expect(approveResponse.json()).toMatchObject({
      job: {
        mode: "scheduled",
        scheduledFor,
        status: "approved"
      }
    });

    const prepareResponse = await app.inject({
      method: "POST",
      url: `/jobs/${approveResponse.json().job.id}/prepare`
    });

    expect(prepareResponse.statusCode).toBe(409);
    expect(prepareResponse.json()).toMatchObject({
      error: `Job is scheduled for ${scheduledFor}`
    });

    await app.close();
  });

  it("downloads draft media URLs and passes local media paths to browser prepare", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === "https://example.com/news.png") {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "content-type": "image/png" }
        });
      }
      throw new Error(`Unexpected fetch: ${String(url)}`);
    });

    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    let uploadedMediaPaths: string[] = [];
    const app = buildApp({
      enableBrowserPrepare: true,
      generationProvider: testGenerationProvider,
      preparePost: async (input) => {
        uploadedMediaPaths = input.mediaPaths ?? [];
        return { postUrl: null };
      },
      repository
    });
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "News with image",
      candidates: [{ text: "News with image text", score: {} }],
      metadata: { mediaUrls: ["https://example.com/news.png"] }
    });
    const approved = await repository.approveDraft({
      draftId: created.draft.id,
      editedText: "News with image text"
    });

    const response = await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/prepare` });

    expect(response.statusCode).toBe(200);
    expect(uploadedMediaPaths).toHaveLength(1);
    expect(uploadedMediaPaths[0]).toContain("data/media/");
    expect(uploadedMediaPaths[0]).toMatch(/\.png$/);

    await app.close();
  });

  it("recovers stale running jobs before starting a new browser job", async () => {
    let currentTime = "2026-04-24T17:00:00.000Z";
    const repository = createMemoryRepository({
      now: () => currentTime
    });
    const app = buildApp({ repository, generationProvider: testGenerationProvider });

    const firstDraft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Old job",
      candidates: [{ text: "Old value post", score: {} }]
    });
    const firstApproved = await repository.approveDraft({
      draftId: firstDraft.draft.id,
      editedText: "Old value post"
    });
    await repository.updateJobStatus(firstApproved.job.id, "queued");
    await repository.updateJobStatus(firstApproved.job.id, "running");

    currentTime = "2026-04-24T17:20:00.000Z";
    const nextDraft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Next job",
      candidates: [{ text: "Next value post", score: {} }]
    });
    const nextApproved = await repository.approveDraft({
      draftId: nextDraft.draft.id,
      editedText: "Next value post"
    });

    const response = await app.inject({
      method: "POST",
      url: `/jobs/${nextApproved.job.id}/prepare`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      job: {
        id: nextApproved.job.id,
        status: "prepared"
      }
    });
    await expect(repository.getJob(firstApproved.job.id)).resolves.toMatchObject({
      status: "failed"
    });
    await expect(repository.listAttempts(firstApproved.job.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorCode: "stale_running_job",
          status: "failed"
        })
      ])
    );

    await app.close();
  });

  it("recovers stale running autopost jobs without reposting them after restart", async () => {
    let nowMs = Date.parse("2026-04-24T17:20:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const repository = createMemoryRepository({
      now: () => new Date(nowMs).toISOString()
    });
    let browserCalled = false;
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async () => {
        browserCalled = true;
        return { postUrl: "https://x.com/personal/status/should-not-happen" };
      },
      repository
    });
    nowMs = Date.parse("2026-04-24T17:00:00.000Z");
    const draft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Interrupted autopost",
      candidates: [{ text: "Interrupted autopost text", score: {} }]
    });
    const approved = await repository.approveDraft({
      draftId: draft.draft.id,
      editedText: "Interrupted autopost text",
      mode: "autopost"
    });
    await repository.updateJobStatus(approved.job.id, "queued");
    await repository.updateJobStatus(approved.job.id, "running");

    nowMs = Date.parse("2026-04-24T17:20:00.000Z");
    const recovery = await app.inject({ method: "POST", url: "/jobs/recover-stale" });
    const postReady = await app.inject({
      method: "POST",
      url: "/jobs/post-ready",
      payload: { accountId: "account_personal" }
    });

    expect(recovery.statusCode).toBe(200);
    expect(recovery.json()).toMatchObject({ recoveredCount: 1 });
    await expect(repository.getJob(approved.job.id)).resolves.toMatchObject({ status: "failed" });
    await expect(repository.listAttempts(approved.job.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          errorCode: "stale_running_job",
          errorMessage: expect.stringContaining("Verify X manually")
        })
      ])
    );
    expect(postReady.statusCode).toBe(200);
    expect(postReady.json()).toMatchObject({ failed: 0, posted: 0, total: 0 });
    expect(browserCalled).toBe(false);

    await app.close();
  });

  it("posts all ready jobs sequentially from one request", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const postedTexts: string[] = [];
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async (input) => {
        postedTexts.push(input.text);
        return { postUrl: `https://x.com/personal/status/${postedTexts.length}` };
      },
      repository
    });

    for (const text of ["Ready one", "Ready two", "Ready three"]) {
      const draft = await repository.createDraft({
        accountId: "account_personal",
        sourceInput: text,
        candidates: [{ text, score: {} }]
      });
      await repository.approveDraft({ draftId: draft.draft.id, editedText: text });
    }
    const scheduledDraft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Later",
      candidates: [{ text: "Later", score: {} }]
    });
    await repository.approveDraft({
      draftId: scheduledDraft.draft.id,
      editedText: "Later",
      mode: "scheduled",
      scheduledFor: "2999-04-25T15:30:00.000Z"
    });

    const response = await app.inject({
      method: "POST",
      url: "/jobs/post-ready",
      payload: { accountId: "account_personal" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      failed: 0,
      posted: 3,
      total: 3
    });
    expect(postedTexts).toHaveLength(3);
    expect(new Set(postedTexts)).toEqual(new Set(["ready one", "ready two", "ready three"]));
    await expect(repository.listPostHistory()).resolves.toHaveLength(3);
    await expect(repository.getJob(response.json().results[0].jobId)).resolves.toMatchObject({ status: "posted" });

    await app.close();
  });

  it("allows only one concurrent post request to claim an autopost job", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    let browserCalls = 0;
    const releasePost: { current?: () => void } = {};
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async () => {
        browserCalls += 1;
        await new Promise<void>((resolve) => {
          releasePost.current = resolve;
        });
        return { postUrl: "https://x.com/personal/status/once" };
      },
      repository
    });
    const draft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Post once",
      candidates: [{ text: "Post once text", score: {} }]
    });
    const approved = await repository.approveDraft({
      draftId: draft.draft.id,
      editedText: "Post once text",
      mode: "autopost"
    });

    const first = app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` });
    await vi.waitFor(() => expect(browserCalls).toBe(1));
    const second = await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` });
    releasePost.current?.();
    const firstResponse = await first;

    expect([firstResponse.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect(browserCalls).toBe(1);
    await expect(repository.listPostHistory()).resolves.toHaveLength(1);

    await app.close();
  });

  it("does not retry a failed post job because it may already have reached X", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    let browserCalled = false;
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async () => {
        browserCalled = true;
        return { postUrl: "https://x.com/personal/status/should-not-happen" };
      },
      repository
    });
    const draft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Maybe posted before crash",
      candidates: [{ text: "Maybe posted before crash", score: {} }]
    });
    const approved = await repository.approveDraft({
      draftId: draft.draft.id,
      editedText: "Maybe posted before crash",
      mode: "autopost"
    });
    await repository.updateJobStatus(approved.job.id, "queued");
    await repository.updateJobStatus(approved.job.id, "running");
    await repository.updateJobStatus(approved.job.id, "failed");

    const direct = await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` });
    const batch = await app.inject({
      method: "POST",
      url: "/jobs/post-ready",
      payload: { accountId: "account_personal" }
    });

    expect(direct.statusCode).toBe(409);
    expect(direct.json()).toMatchObject({ error: "Job must be approved or prepared before posting: failed" });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toMatchObject({ failed: 0, posted: 0, total: 0 });
    expect(browserCalled).toBe(false);
    await expect(repository.listPostHistory()).resolves.toHaveLength(0);

    await app.close();
  });

  it("rejects posting text already present in account history", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    let browserCalled = false;
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async () => {
        browserCalled = true;
        return { postUrl: "https://x.com/personal/status/duplicate" };
      },
      repository
    });
    const draft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Duplicate from old history",
      candidates: [{ text: "Already posted text", score: {} }]
    });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: draft.draft.id,
      postedText: "Already posted text",
      postUrl: "https://x.com/personal/status/old"
    });
    const approved = await repository.approveDraft({
      draftId: draft.draft.id,
      editedText: "Already   posted text",
      mode: "autopost"
    });

    const response = await app.inject({
      method: "POST",
      url: `/jobs/${approved.job.id}/post`
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "Duplicate post text for this account" });
    expect(browserCalled).toBe(false);

    await app.close();
  });

  it("allows up to two posts from one source packet", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    let browserCalled = false;
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async () => {
        browserCalled = true;
        return { postUrl: "https://x.com/personal/status/source-duplicate" };
      },
      repository
    });
    const packet = await repository.createSourcePacket({
      accountId: "account_personal",
      facts: ["Same packet fact"],
      sourceType: "news",
      summary: "Same packet summary",
      title: "Same packet title",
      tweetType: "useful_info",
      url: "https://example.com/same-packet"
    });
    for (const [index, text] of ["First source post"].entries()) {
      const draft = await repository.createDraft({
        accountId: "account_personal",
        sourceInput: `Existing source draft ${index + 1}`,
        metadata: { sourcePacketId: packet.id },
        candidates: [{ text, score: { sourcePacketId: packet.id } }]
      });
      await repository.createPostHistory({
        accountId: "account_personal",
        draftId: draft.draft.id,
        postedText: text,
        postUrl: `https://x.com/personal/status/source-${index + 1}`,
        sourcePacketId: packet.id
      });
    }
    const second = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Second source draft",
      metadata: { sourcePacketId: packet.id },
      candidates: [{ text: "Second source post", score: { sourcePacketId: packet.id } }]
    });
    const approved = await repository.approveDraft({
      draftId: second.draft.id,
      editedText: "Second source post",
      mode: "autopost"
    });

    const response = await app.inject({
      method: "POST",
      url: `/jobs/${approved.job.id}/post`
    });

    expect(response.statusCode).toBe(200);
    expect(browserCalled).toBe(true);

    await app.close();
  });

  it("rejects posting a source packet after two history entries", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    let browserCalled = false;
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async () => {
        browserCalled = true;
        return { postUrl: "https://x.com/personal/status/source-duplicate" };
      },
      repository
    });
    const packet = await repository.createSourcePacket({
      accountId: "account_personal",
      facts: ["Same packet fact"],
      sourceType: "news",
      summary: "Same packet summary",
      title: "Same packet title",
      tweetType: "useful_info",
      url: "https://example.com/same-packet"
    });
    for (const [index, text] of ["First source post", "Second source post"].entries()) {
      const draft = await repository.createDraft({
        accountId: "account_personal",
        sourceInput: `Posted source draft ${index + 1}`,
        metadata: { sourcePacketId: packet.id },
        candidates: [{ text, score: { sourcePacketId: packet.id } }]
      });
      await repository.createPostHistory({
        accountId: "account_personal",
        draftId: draft.draft.id,
        postedText: text,
        postUrl: `https://x.com/personal/status/source-${index + 1}`,
        sourcePacketId: packet.id
      });
    }
    const third = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Third source draft",
      metadata: { sourcePacketId: packet.id },
      candidates: [{ text: "Third source post", score: { sourcePacketId: packet.id } }]
    });
    const approved = await repository.approveDraft({
      draftId: third.draft.id,
      editedText: "Third source post",
      mode: "autopost"
    });

    const response = await app.inject({
      method: "POST",
      url: `/jobs/${approved.job.id}/post`
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "Source packet already reached 2 posts for this account" });
    expect(browserCalled).toBe(false);

    await app.close();
  });

  it("adds required article source URL before browser posting", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    let postedText = "";
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async (input) => {
        postedText = input.text;
        return { postUrl: "https://x.com/personal/status/article-link" };
      },
      repository
    });
    const packet = await repository.createSourcePacket({
      accountId: "account_personal",
      facts: ["Database failover article", "Operators get safer recovery defaults."],
      sourceType: "news",
      summary: "Operators get safer recovery defaults.",
      title: "Database failover article",
      tweetType: "article_summary",
      url: "https://example.com/database-failover"
    });
    const draft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Article draft",
      metadata: { sourcePacketId: packet.id },
      candidates: [{ text: "Database failover got safer defaults for operators.", score: { sourcePacketId: packet.id } }]
    });
    const approved = await repository.approveDraft({
      draftId: draft.draft.id,
      editedText: "Database failover got safer defaults for operators.",
      mode: "autopost"
    });

    const response = await app.inject({
      method: "POST",
      url: `/jobs/${approved.job.id}/post`
    });

    expect(response.statusCode).toBe(200);
    expect(postedText).toBe("database failover got safer defaults for operators. https://example.com/database-failover");
    await expect(repository.listPostHistory()).resolves.toMatchObject([
      {
        postedText: "database failover got safer defaults for operators. https://example.com/database-failover",
        sourceUrl: "https://example.com/database-failover"
      }
    ]);

    await app.close();
  });

  it("purges posted tweet history after 24 hours", async () => {
    let nowMs = Date.parse("2026-04-24T17:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const repository = createMemoryRepository({
      now: () => new Date(nowMs).toISOString()
    });
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async () => ({ postUrl: "https://x.com/personal/status/ttl" }),
      repository
    });
    const draft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "TTL",
      candidates: [{ text: "History ttl text", score: {} }]
    });
    const approved = await repository.approveDraft({
      draftId: draft.draft.id,
      editedText: "History ttl text",
      mode: "autopost",
      scheduledFor: new Date(nowMs).toISOString()
    });

    expect((await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/history" })).json().history).toHaveLength(1);

    nowMs = Date.parse("2026-04-25T17:00:01.000Z");
    expect((await app.inject({ method: "GET", url: "/history" })).json().history).toHaveLength(0);

    await app.close();
  });

  it("analyzes recent post history for quality issues", async () => {
    const repository = createMemoryRepository({
      now: () => new Date().toISOString()
    });
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository
    });
    const first = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Article summary",
      candidates: [{ text: "AI is changing developer tools. Here is why it matters.", score: {} }]
    });
    const second = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Repeated article summary",
      candidates: [{ text: "AI is changing developer tools. Here is why it matters.", score: {} }]
    });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: first.draft.id,
      postedText: "AI is changing developer tools. Here is why it matters.",
      postUrl: "https://x.com/personal/status/analysis-1",
      sourceTitle: "Developer tools article",
      sourceType: "feed",
      sourceUrl: "https://example.com/developer-tools",
      tweetType: "article_summary"
    });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: second.draft.id,
      postedText: "AI is changing developer tools. Here is why it matters.",
      postUrl: "https://x.com/personal/status/analysis-2",
      sourceTitle: "Developer tools article",
      sourceType: "feed",
      sourceUrl: "https://example.com/developer-tools",
      tweetType: "article_summary"
    });

    const response = await app.inject({
      method: "GET",
      url: "/history/analysis?accountId=account_personal"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      analysis: {
        postCount: 2,
        summary: {
          duplicate_text: 1,
          generic_phrasing: 2,
          missing_link: 2
        }
      }
    });

    await app.close();
  });

  it("post-processes approved and posted tweet text before browser use", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    let postedText = "";
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async (input) => {
        postedText = input.text;
        return { postUrl: "https://x.com/personal/status/postprocessed" };
      },
      repository
    });
    const draft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Post process",
      candidates: [{ text: "Local-first — auditable — posting works.", score: {} }]
    });
    const approveResponse = await app.inject({
      method: "POST",
      url: `/drafts/${draft.draft.id}/approve`,
      payload: {
        editedText: "Local-first — auditable — posting works.",
        mode: "autopost"
      }
    });

    expect(approveResponse.statusCode).toBe(201);
    expect(approveResponse.json()).toMatchObject({
      draft: {
        editedText: "local-first, auditable, posting works."
      }
    });
    expect((await app.inject({ method: "POST", url: `/jobs/${approveResponse.json().job.id}/post` })).statusCode).toBe(200);
    expect(postedText).toBe("local-first, auditable, posting works.");

    await app.close();
  });

  it("creates a scheduled batch with tweet type metadata", async () => {
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      })
    });

    const response = await app.inject({
      method: "POST",
      url: "/draft-batches",
      payload: {
        accountId: "account_personal",
        ideas: ["Explain source packets", "Explain deterministic scheduling"],
        scheduleSpacingMinutes: 60,
        scheduleStart: "2999-04-25T15:30:00.000Z",
        tweetType: "guide"
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      items: [
        {
          draft: {
            status: "created",
            metadata: expect.objectContaining({
              scheduleStart: "2999-04-25T15:30:00.000Z"
            })
          }
        },
        {
          draft: {
            status: "created",
            metadata: expect.objectContaining({
              scheduleStart: "2999-04-25T16:30:00.000Z"
            })
          }
        }
      ]
    });

    await app.close();
  });

  it("creates source packets and drafts from them", async () => {
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      })
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/source-packets",
      payload: {
        accountId: "account_personal",
        facts: ["Compute is becoming the bottleneck.", "Distribution matters less than reliable workflow."],
        sourceType: "news",
        summary: "AI infrastructure spending is reshaping the market.",
        title: "AI infra shift",
        tweetType: "news_context",
        url: "https://example.com/ai-infra"
      }
    });

    expect(createResponse.statusCode).toBe(201);
    const packet = createResponse.json().packet;
    expect(packet).toMatchObject({
      sourceType: "news",
      status: "new",
      tweetType: "news_context"
    });

    const draftResponse = await app.inject({
      method: "POST",
      url: `/source-packets/${packet.id}/draft`
    });

    expect(draftResponse.statusCode).toBe(201);
    expect(draftResponse.json()).toMatchObject({
      draft: {
        accountId: "account_personal",
        status: "selected"
      },
      packet: {
        id: packet.id,
        status: "drafted"
      }
    });

    const listResponse = await app.inject({
      method: "GET",
      url: "/source-packets?accountId=account_personal"
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      packets: [{ id: packet.id, status: "drafted" }]
    });

    await app.close();
  });

  it("deletes a generated draft from a source packet and resets the packet", async () => {
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      })
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/source-packets",
      payload: {
        accountId: "account_personal",
        facts: ["Battery research can change energy market assumptions."],
        sourceType: "news",
        summary: "A science story has economy implications.",
        title: "Battery science market impact",
        tweetType: "news_context",
        url: "https://example.com/battery-science"
      }
    });
    const packet = createResponse.json().packet;
    const draftResponse = await app.inject({
      method: "POST",
      url: `/source-packets/${packet.id}/draft`
    });

    expect(draftResponse.statusCode).toBe(201);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/source-packets/${packet.id}/draft`
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({
      deleted: true,
      draft: {
        id: draftResponse.json().draft.id
      },
      packet: {
        id: packet.id,
        status: "new"
      }
    });

    const jobsResponse = await app.inject({
      method: "GET",
      url: "/jobs?accountId=account_personal"
    });
    expect(jobsResponse.json().jobs).toHaveLength(0);

    await app.close();
  });

  it("deletes a single source packet and its non-posted generated draft", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/source-packets",
      payload: {
        accountId: "account_personal",
        facts: ["Source delete fact"],
        sourceType: "news",
        summary: "Source delete summary",
        title: "Source delete",
        tweetType: "news_context",
        url: "https://example.com/source-delete"
      }
    });
    const packet = createResponse.json().packet;
    const draftResponse = await app.inject({
      method: "POST",
      url: `/source-packets/${packet.id}/draft`
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/source-packets/${packet.id}`
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({
      deleted: true,
      draftId: draftResponse.json().draft.id,
      packet: { id: packet.id }
    });
    await expect(repository.getSourcePacket(packet.id)).resolves.toBeNull();
    await expect(repository.getDraft(draftResponse.json().draft.id)).resolves.toBeNull();

    await app.close();
  });

  it("deletes all source packets and removes non-posted generated drafts", async () => {
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      })
    });

    for (const title of ["Battery market source", "Science policy source"]) {
      const createResponse = await app.inject({
        method: "POST",
        url: "/source-packets",
        payload: {
          accountId: "account_personal",
          facts: [`${title} fact`],
          sourceType: "news",
          summary: `${title} summary`,
          title,
          tweetType: "news_context",
          url: `https://example.com/${title.toLowerCase().replace(/\s+/g, "-")}`
        }
      });
      await app.inject({
        method: "POST",
        url: `/source-packets/${createResponse.json().packet.id}/draft`
      });
    }

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/source-packets?accountId=account_personal"
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({
      deletedCount: 2,
      skippedCount: 0
    });
    await expect(app.inject({ method: "GET", url: "/source-packets?accountId=account_personal" })).resolves.toMatchObject({
      statusCode: 200
    });
    expect((await app.inject({ method: "GET", url: "/source-packets?accountId=account_personal" })).json().packets).toHaveLength(0);

    await app.close();
  });

  it("deletes source packet links without deleting drafts kept by post history", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository
    });
    const createResponse = await app.inject({
      method: "POST",
      url: "/source-packets",
      payload: {
        accountId: "account_personal",
        facts: ["Posted source fact"],
        sourceType: "news",
        summary: "Posted source summary",
        title: "Posted source",
        tweetType: "news_context",
        url: "https://example.com/posted-source"
      }
    });
    const packet = createResponse.json().packet;
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Posted source",
      candidates: [{ text: "Posted source text", score: { sourcePacketId: packet.id } }]
    });
    await repository.markSourcePacketDrafted(packet.id);
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: created.draft.id,
      postedText: "Posted source text",
      postUrl: "https://x.com/personal/status/posted-source"
    });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/source-packets?accountId=account_personal"
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ deletedCount: 1, skippedCount: 0 });
    await expect(repository.getSourcePacket(packet.id)).resolves.toBeNull();
    await expect(repository.getDraft(created.draft.id)).resolves.toMatchObject({ draft: { id: created.draft.id } });
    await expect(repository.listPostHistory()).resolves.toHaveLength(1);

    await app.close();
  });

  it("removes source packet links after source-generated drafts are posted", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const app = buildApp({
      enableBrowserPost: true,
      generationProvider: testGenerationProvider,
      preparePost: async () => ({ postUrl: "https://x.com/personal/status/1" }),
      repository
    });

    const createResponse = await app.inject({
      method: "POST",
      url: "/source-packets",
      payload: {
        accountId: "account_personal",
        facts: ["Science funding affects markets."],
        sourceType: "news",
        summary: "Science and economy source.",
        title: "Science economy source",
        tweetType: "news_context",
        url: "https://example.com/science-economy"
      }
    });
    const packet = createResponse.json().packet;
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Science economy source",
      candidates: [
        {
          text: "Science funding is becoming a markets story.",
          score: { sourcePacketId: packet.id }
        }
      ]
    });
    await repository.markSourcePacketDrafted(packet.id);
    const approved = await repository.approveDraft({
      draftId: created.draft.id,
      editedText: "Science funding is becoming a markets story.",
      mode: "autopost"
    });

    const postResponse = await app.inject({
      method: "POST",
      url: `/jobs/${approved.job.id}/post`
    });

    expect(postResponse.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/source-packets?accountId=account_personal" })).json().packets).toHaveLength(0);
    await expect(repository.listPostHistory()).resolves.toMatchObject([
      {
        postedText: "science funding is becoming a markets story. https://example.com/science-economy",
        sourcePacketId: packet.id,
        sourceTitle: "Science economy source",
        sourceType: "news",
        sourceUrl: "https://example.com/science-economy",
        tweetType: "news_context"
      }
    ]);

    await app.close();
  });

  it("does not prepare jobs for draft-only accounts", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const app = buildApp({ repository, generationProvider: testGenerationProvider });

    await repository.updateAccount("account_personal", { postingMode: "draft_only" });
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Draft only",
      candidates: [{ text: "Draft only text", score: {} }]
    });
    const approved = await repository.approveDraft({ draftId: created.draft.id, editedText: "Draft only text" });

    const prepareResponse = await app.inject({
      method: "POST",
      url: `/jobs/${approved.job.id}/prepare`
    });

    expect(prepareResponse.statusCode).toBe(409);
    await app.close();
  });

  it("deletes non-running jobs and their queue entry", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const app = buildApp({ repository, generationProvider: testGenerationProvider });
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Delete queued job",
      candidates: [{ text: "Delete queued job text", score: {} }]
    });
    const approved = await repository.approveDraft({ draftId: created.draft.id, editedText: "Delete queued job text" });

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/jobs/${approved.job.id}`
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ job: { id: approved.job.id } });
    await expect(repository.getJob(approved.job.id)).resolves.toBeNull();
    await app.close();
  });

  it("filters jobs by accountId query", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z",
      snapshot: {
        accounts: [
          {
            id: "account_personal",
            handle: "personal-main",
            displayName: "Personal main",
            profileDir: "profiles/personal-main",
            styleProfileId: "style_default",
            postingMode: "prepare_only",
            enabled: true,
            dailyPostLimit: 5,
            quietHoursStart: null,
            quietHoursEnd: null,
            createdAt: "2026-04-24T17:00:00.000Z",
            updatedAt: "2026-04-24T17:00:00.000Z"
          },
          {
            id: "account_alt",
            handle: "alt",
            displayName: "Alt",
            profileDir: "profiles/alt",
            styleProfileId: "style_default",
            postingMode: "prepare_only",
            enabled: true,
            dailyPostLimit: 5,
            quietHoursStart: null,
            quietHoursEnd: null,
            createdAt: "2026-04-24T17:00:00.000Z",
            updatedAt: "2026-04-24T17:00:00.000Z"
          }
        ]
      }
    });
    const app = buildApp({ repository, generationProvider: testGenerationProvider });

    const draftA = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "A",
      candidates: [{ text: "A text", score: {} }]
    });
    const draftB = await repository.createDraft({
      accountId: "account_alt",
      sourceInput: "B",
      candidates: [{ text: "B text", score: {} }]
    });
    await repository.approveDraft({ draftId: draftA.draft.id, editedText: "A text" });
    await repository.approveDraft({ draftId: draftB.draft.id, editedText: "B text" });

    const response = await app.inject({
      method: "GET",
      url: "/jobs?accountId=account_personal"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      jobs: [{ accountId: "account_personal" }]
    });
    expect(response.json().jobs).toHaveLength(1);

    await app.close();
  });

  it("deletes all jobs only for the requested account", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z",
      snapshot: {
        accounts: [
          {
            id: "account_personal",
            handle: "personal-main",
            displayName: "Personal",
            profileDir: "profiles/personal-main",
            styleProfileId: "style_default",
            postingMode: "prepare_only",
            enabled: true,
            dailyPostLimit: 5,
            quietHoursStart: null,
            quietHoursEnd: null,
            createdAt: "2026-04-24T17:00:00.000Z",
            updatedAt: "2026-04-24T17:00:00.000Z"
          },
          {
            id: "account_alt",
            handle: "alt",
            displayName: "Alt",
            profileDir: "profiles/alt",
            styleProfileId: "style_default",
            postingMode: "prepare_only",
            enabled: true,
            dailyPostLimit: 5,
            quietHoursStart: null,
            quietHoursEnd: null,
            createdAt: "2026-04-24T17:00:00.000Z",
            updatedAt: "2026-04-24T17:00:00.000Z"
          }
        ]
      }
    });
    const app = buildApp({ repository, generationProvider: testGenerationProvider });
    const draftA = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "A",
      candidates: [{ text: "Delete A", score: {} }]
    });
    const draftB = await repository.createDraft({
      accountId: "account_alt",
      sourceInput: "B",
      candidates: [{ text: "Keep B", score: {} }]
    });
    const jobA = await repository.approveDraft({ draftId: draftA.draft.id, editedText: "Delete A" });
    const jobB = await repository.approveDraft({ draftId: draftB.draft.id, editedText: "Keep B" });

    const response = await app.inject({
      method: "DELETE",
      url: "/jobs?accountId=account_personal"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deletedCount: 1, ids: [jobA.job.id] });
    await expect(repository.getJob(jobA.job.id)).resolves.toBeNull();
    await expect(repository.getJob(jobB.job.id)).resolves.toMatchObject({ id: jobB.job.id });

    await app.close();
  });

  it("creates, lists, updates, and deletes ingest configs", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const app = buildApp({ repository, generationProvider: testGenerationProvider });

    const createResponse = await app.inject({
      method: "POST",
      url: "/ingest-configs",
      payload: {
        accountId: "account_personal",
        sourceType: "news",
        maxPacketsPerDay: 10,
        metadata: { region: "global" },
        tweetTypeMix: { feed_observation: 30, news_context: 70 },
        scheduleWindowStart: "09:00",
        scheduleWindowEnd: "21:00",
        enabled: true
      }
    });

    expect(createResponse.statusCode).toBe(201);
    const createdConfig = createResponse.json().config;
    expect(createdConfig.sourceType).toBe("news");
    expect(createdConfig.maxPacketsPerDay).toBe(10);
    expect(createdConfig.metadata).toEqual({ region: "global" });

    const listResponse = await app.inject({
      method: "GET",
      url: "/ingest-configs?accountId=account_personal"
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().configs).toHaveLength(1);

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/ingest-configs/${createdConfig.id}`,
      payload: {
        maxPacketsPerDay: 20,
        metadata: { region: "us" },
        enabled: false
      }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json().config.maxPacketsPerDay).toBe(20);
    expect(updateResponse.json().config.metadata).toEqual({ region: "us" });
    expect(updateResponse.json().config.enabled).toBe(false);

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/ingest-configs/${createdConfig.id}`
    });

    expect(deleteResponse.statusCode).toBe(200);

    const listAfterDelete = await app.inject({
      method: "GET",
      url: "/ingest-configs?accountId=account_personal"
    });

    expect(listAfterDelete.json().configs).toHaveLength(0);

    await app.close();
  });

  it("runs ingest runner and creates automated jobs", async () => {
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      }),
      sourceAdapters: [testNewsAdapter]
    });

    // Create enabled ingest config
    await app.inject({
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

    // Run ingest
    const runResponse = await app.inject({
      method: "POST",
      url: "/ingest-run"
    });

    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json().processed).toBe(3);

    // Run ingest again. It should process 0 items because all 3 test items are already processed.
    const runResponse2 = await app.inject({
      method: "POST",
      url: "/ingest-run"
    });

    expect(runResponse2.json().processed).toBe(0);

    // Verify jobs created
    const jobsResponse = await app.inject({
      method: "GET",
      url: "/jobs?accountId=account_personal"
    });

    expect(jobsResponse.json().jobs).toHaveLength(3);
    expect(jobsResponse.json().jobs[0].status).toBe("approved");
    expect(jobsResponse.json().jobs[0].mode).toBe("autopost");

    await app.close();
  });

  it("passes feed metadata to live source adapters and respects disabled configs", async () => {
    const calls: unknown[] = [];
    const feedAdapter: SourceAdapter = {
      name: "test-feed",
      sourceType: "feed",
      async fetch(metadata) {
        calls.push(metadata);
        return [
          {
            title: "Live release notes",
            url: "https://example.com/live-release",
            content: "A live source item from an RSS feed."
          }
        ];
      }
    };
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      }),
      sourceAdapters: [feedAdapter]
    });

    const disabled = await app.inject({
      method: "POST",
      url: "/ingest-configs",
      payload: {
        accountId: "account_personal",
        enabled: false,
        maxPacketsPerDay: 3,
        metadata: { feedUrl: "https://example.com/rss.xml" },
        scheduleWindowStart: "00:00",
        scheduleWindowEnd: "23:59",
        sourceType: "feed",
        tweetTypeMix: { useful_info: 100 }
      }
    });

    expect(disabled.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/ingest-run" })).json().processed).toBe(0);
    expect(calls).toHaveLength(0);

    await app.inject({
      method: "PATCH",
      url: `/ingest-configs/${disabled.json().config.id}`,
      payload: { enabled: true }
    });

    const runResponse = await app.inject({ method: "POST", url: "/ingest-run" });
    expect(runResponse.statusCode).toBe(200);
    expect(runResponse.json().processed).toBe(1);
    expect(calls).toEqual([{ feedUrl: "https://example.com/rss.xml" }]);

    await app.close();
  });
});

describe("automatic worker ingest pipeline", () => {
  it("full pipeline: config -> fetch -> packet -> draft -> job -> prepare", async () => {
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository: createMemoryRepository({
        now: () => "2026-04-24T14:00:00.000Z"
      }),
      sourceAdapters: [testNewsAdapter],
      enableBrowserPrepare: false // dry run
    });

    // 1. Create ingest config
    const configResponse = await app.inject({
      method: "POST",
      url: "/ingest-configs",
      payload: {
        accountId: "account_personal",
        sourceType: "news",
        maxPacketsPerDay: 3,
        tweetTypeMix: { useful_info: 100 },
        scheduleWindowStart: "00:00",
        scheduleWindowEnd: "23:59",
        enabled: true
      }
    });
    expect(configResponse.statusCode).toBe(201);
    const config = configResponse.json().config;

    // 2. Run ingest - fetches from adapter, creates packets, drafts, jobs
    const ingestResponse = await app.inject({ method: "POST", url: "/ingest-run" });
    expect(ingestResponse.statusCode).toBe(200);
    expect(ingestResponse.json().processed).toBe(3);

    // 3. Verify source packets created
    const packetsResponse = await app.inject({ method: "GET", url: "/source-packets" });
    expect(packetsResponse.json().packets).toHaveLength(3);
    expect(packetsResponse.json().packets[0].status).toBe("drafted");

    // 4. Verify jobs created
    const jobsResponse = await app.inject({ method: "GET", url: "/jobs?accountId=account_personal" });
    expect(jobsResponse.json().jobs).toHaveLength(3);
    const job = jobsResponse.json().jobs[0];
    expect(job.status).toBe("approved");
    expect(job.mode).toBe("autopost");

    // 5. Prepare job (dry run)
    const prepareResponse = await app.inject({ method: "POST", url: `/jobs/${job.id}/prepare` });
    expect(prepareResponse.statusCode).toBe(200);
    expect(prepareResponse.json().dryRun).toBe(true);
    expect(prepareResponse.json().job.status).toBe("prepared");

    // 6. Re-ingest - no new packets (already drafted)
    const ingestResponse2 = await app.inject({ method: "POST", url: "/ingest-run" });
    expect(ingestResponse2.json().processed).toBe(0);

    // 7. Disable config - no new packets
    await app.inject({
      method: "PATCH",
      url: `/ingest-configs/${config.id}`,
      payload: { enabled: false }
    });
    const ingestResponse3 = await app.inject({ method: "POST", url: "/ingest-run" });
    expect(ingestResponse3.json().processed).toBe(0);

    await app.close();
  });
});

describe("worker reliability endpoints", () => {
  it("reports worker status and heartbeat state", async () => {
    const app = buildApp({
      repository: createMemoryRepository({
        now: () => "2026-04-24T14:00:00.000Z"
      })
    });

    const initial = await app.inject({ method: "GET", url: "/worker/status" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      hasEnabledIngestConfigs: false,
      workerRunning: false
    });

    const heartbeat = await app.inject({
      method: "POST",
      url: "/worker/heartbeat",
      payload: {
        lastError: null,
        lastIngestAt: "2026-04-24T13:59:00.000Z",
        lastPostAt: null
      }
    });
    expect(heartbeat.statusCode).toBe(200);

    const status = await app.inject({ method: "GET", url: "/worker/status" });
    expect(status.json()).toMatchObject({
      lastIngestAt: "2026-04-24T13:59:00.000Z",
      workerRunning: true
    });
    expect(typeof status.json().lastHeartbeatAt).toBe("string");

    await app.close();
  });

  it("creates one default news ingest config and reuses it on later seed calls", async () => {
    const app = buildApp({
      repository: createMemoryRepository({
        now: () => "2026-04-24T14:00:00.000Z"
      })
    });

    const created = await app.inject({ method: "POST", url: "/ingest-configs/default-news" });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      created: true,
      config: {
        accountId: "account_personal",
        enabled: true,
        sourceType: "news"
      }
    });

    const reused = await app.inject({ method: "POST", url: "/ingest-configs/default-news" });
    expect(reused.statusCode).toBe(200);
    expect(reused.json()).toMatchObject({
      created: false,
      config: {
        id: created.json().config.id
      }
    });

    const configs = await app.inject({ method: "GET", url: "/ingest-configs" });
    expect(configs.json().configs).toHaveLength(1);

    await app.close();
  });

  it("accepts async ingest without waiting for slow adapter fetch", async () => {
    let releaseFetch: () => void = () => undefined;
    const slowAdapter: SourceAdapter = {
      name: "slow-news",
      sourceType: "news",
      async fetch() {
        await new Promise<void>((resolve) => {
          releaseFetch = resolve;
        });
        return [];
      }
    };
    const app = buildApp({
      generationProvider: testGenerationProvider,
      repository: createMemoryRepository({
        now: () => "2026-04-24T14:00:00.000Z"
      }),
      sourceAdapters: [slowAdapter]
    });

    await app.inject({
      method: "POST",
      url: "/ingest-configs",
      payload: {
        accountId: "account_personal",
        sourceType: "news",
        scheduleWindowStart: "00:00",
        scheduleWindowEnd: "23:59",
        enabled: true
      }
    });

    const response = await app.inject({ method: "POST", url: "/ingest-run/async" });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      accepted: true,
      ingestRun: { running: true }
    });

    const duplicate = await app.inject({ method: "POST", url: "/ingest-run/async" });
    expect(duplicate.statusCode).toBe(202);
    expect(duplicate.json()).toMatchObject({
      accepted: false,
      reason: "already_running"
    });

    releaseFetch();
    await vi.waitFor(async () => {
      const status = await app.inject({ method: "GET", url: "/worker/status" });
      expect(status.json().ingestRun.running).toBe(false);
    });

    await app.close();
  });
});
