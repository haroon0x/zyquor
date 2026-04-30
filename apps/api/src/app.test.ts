import { createMemoryRepository } from "@zyquor/storage";
import type { SourceAdapter } from "@zyquor/adapters";
import type { DraftGenerationProvider } from "@zyquor/generation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

afterEach(() => {
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
      text: `${input.idea.trim()} Test candidate ${index + 1}.`,
      score: { provider: "test", rank: index + 1 }
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
    expect(new Set(postedTexts)).toEqual(new Set(["Ready one", "Ready two", "Ready three"]));
    await expect(repository.listPostHistory()).resolves.toHaveLength(3);
    await expect(repository.getJob(response.json().results[0].jobId)).resolves.toMatchObject({ status: "posted" });

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
