import type { DraftGenerationProvider } from "@zyquor/generation";
import { createSqliteRepository } from "@zyquor/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const generationProvider: DraftGenerationProvider = {
  name: "ollama",
  model: "test",
  async generateDraftCandidates() {
    return [];
  }
};

beforeEach(() => {
  process.env.ZYQUOR_POST_GAP_MIN_MINUTES = "0";
  process.env.ZYQUOR_DAILY_POST_VARIANCE_MIN = "4";
  process.env.ZYQUOR_DAILY_POST_VARIANCE_MAX = "4";
});

afterEach(() => {
  delete process.env.ZYQUOR_POST_GAP_MIN_MINUTES;
  delete process.env.ZYQUOR_DAILY_POST_VARIANCE_MIN;
  delete process.env.ZYQUOR_DAILY_POST_VARIANCE_MAX;
  vi.restoreAllMocks();
});

describe("jobs routes", () => {
  it("shuffles ready jobs and posts them sequentially", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const repository = await createSqliteRepository(":memory:");
    const postedTexts: string[] = [];
    const app = buildApp({
      checkXLogin: async () => ({ loggedIn: true, handle: "personal-main" }),
      enableBrowserPost: true,
      generationProvider,
      preparePost: async ({ text }) => {
        postedTexts.push(text);
        return { postUrl: `https://x.com/personal/status/${postedTexts.length}` };
      },
      repository
    });

    for (const text of ["First ready", "Second ready", "Third ready"]) {
      const created = await repository.createDraft({
        accountId: "account_personal",
        sourceInput: text,
        candidates: [{ text, score: {} }]
      });
      await repository.approveDraft({ draftId: created.draft.id, editedText: text });
    }

    const response = await app.inject({
      method: "POST",
      url: "/jobs/post-ready",
      payload: { accountId: "account_personal", bypassSpacing: true }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ failed: 0, posted: 3, total: 3 });
    expect(postedTexts).toEqual(["second ready", "third ready", "first ready"]);
    await app.close();
  });

  it("sets and clears schedules only for reschedulable jobs", async () => {
    const repository = await createSqliteRepository(":memory:");
    const app = buildApp({
      checkXLogin: async () => ({ loggedIn: true, handle: "personal-main" }), generationProvider, repository });
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Reschedule this",
      candidates: [{ text: "Reschedule this", score: {} }]
    });
    const approved = await repository.approveDraft({
      draftId: created.draft.id,
      editedText: "Reschedule this"
    });

    const scheduled = await app.inject({
      method: "PATCH",
      url: `/jobs/${approved.job.id}`,
      payload: { scheduledFor: "2026-07-20T09:30:00.000Z" }
    });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json().job.scheduledFor).toBe("2026-07-20T09:30:00.000Z");

    const cleared = await app.inject({
      method: "PATCH",
      url: `/jobs/${approved.job.id}`,
      payload: { scheduledFor: null }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().job.scheduledFor).toBeNull();

    await repository.updateJobStatus(approved.job.id, "queued");
    await repository.updateJobStatus(approved.job.id, "running");
    await repository.updateJobStatus(approved.job.id, "prepared");
    const prepared = await app.inject({
      method: "PATCH",
      url: `/jobs/${approved.job.id}`,
      payload: { scheduledFor: "2026-07-21T09:30:00.000Z" }
    });
    expect(prepared.statusCode).toBe(200);

    await repository.updateJobStatus(approved.job.id, "failed");
    const failed = await app.inject({
      method: "PATCH",
      url: `/jobs/${approved.job.id}`,
      payload: { scheduledFor: null }
    });
    expect(failed.statusCode).toBe(409);

    const invalid = await app.inject({
      method: "PATCH",
      url: `/jobs/${approved.job.id}`,
      payload: { scheduledFor: "tomorrow" }
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PATCH",
      url: "/jobs/missing",
      payload: { scheduledFor: null }
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
