import { createSqliteRepository } from "@zyquor/storage";
import type { DraftGenerationProvider } from "@zyquor/generation";
import type { XFeedTweet } from "@zyquor/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const accountId = "account_personal";

const PASSING_TEXT =
  "We replaced the on-call query cache after our benchmark hit 40 p95 misses per hour, because silent tail latency was costing real users.";

function tweet(): XFeedTweet {
  const statusId = "19804432001";
  return {
    id: statusId,
    authorHandle: "target_user",
    authorName: "Target User",
    text: "target asks about deployment hygiene",
    url: `https://x.com/target_user/status/${statusId}`,
    publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    isRetweet: false
  };
}

const generationProvider: DraftGenerationProvider = {
  name: "ollama",
  model: "test-local",
  async generateDraftCandidates() {
    return [{ text: PASSING_TEXT, score: { provider: "ollama", model: "test-local", rank: 1, quality: 9 } }];
  }
};

let fetchTweet: ReturnType<typeof vi.fn>;
let fetchAccountTimeline: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchTweet = vi.fn();
  fetchAccountTimeline = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Creates a failed reply job with approved text, ready for the retry endpoint.
async function buildFailedJob() {
  const repository = await createSqliteRepository(":memory:");
  const app = buildApp({
    repository,
    generationProvider,
    fetchTweet: fetchTweet as never,
    fetchAccountTimeline: fetchAccountTimeline as never,
    enableBrowserPost: true,
    checkXLogin: async () => ({ loggedIn: true, handle: "personal-main" }),
    preparePost: async () => ({ postUrl: "https://x.com/personal/status/retry-mock" })
  });
  fetchTweet.mockResolvedValue({ tweet: tweet(), url: "https://x.com/home", replies: [] });
  const created = await app.inject({
    method: "POST",
    url: "/replies/from-url",
    payload: { accountId, url: tweet().url, useMemory: false }
  });
  expect(created.statusCode, created.body).toBe(201);
  const { draft } = created.json();
  const approved = await app.inject({
    method: "POST",
    url: `/drafts/${draft.id}/approve`,
    payload: { editedText: PASSING_TEXT, screened: true, mode: "review_required" }
  });
  expect(approved.statusCode, approved.body).toBe(201);
  const jobId = approved.json().job.id;
  // Force the failure state the retry endpoint is built for, along the real
  // transition path (approved -> queued -> running -> failed).
  await repository.updateJobStatus(jobId, "queued");
  await repository.updateJobStatus(jobId, "running");
  await repository.updateJobStatus(jobId, "failed");
  const account = await repository.getAccount(accountId);
  return { app, repository, jobId, handle: account!.handle.replace(/^@/, "").toLowerCase() };
}

describe("POST /jobs/:id/retry (verify-then-retry)", () => {
  it("marks the job posted without reposting when the reply already reached the thread", async () => {
    const { app, jobId, handle } = await buildFailedJob();
    fetchTweet.mockResolvedValue({
      tweet: tweet(),
      url: "https://x.com/home",
      replies: [{ id: "1", authorHandle: handle, authorName: "Self", text: `  ${PASSING_TEXT}  `, url: "https://x.com/personal/status/777", isRetweet: false }]
    });

    const response = await app.inject({ method: "POST", url: `/jobs/${jobId}/retry` });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.verified).toBe(true);
    expect(body.replyUrl).toBe("https://x.com/personal/status/777");
    expect(body.job.status).toBe("posted");
  });

  it("falls back to the account replies timeline when the thread will not render", async () => {
    const { app, jobId, handle } = await buildFailedJob();
    fetchTweet.mockRejectedValue(new Error("Timed out waiting for the target tweet to render"));
    fetchAccountTimeline.mockResolvedValue({
      tweets: [{ id: "t1", authorHandle: handle, authorName: "Self", text: PASSING_TEXT, url: "https://x.com/personal/status/888", isRetweet: false }],
      url: "https://x.com/personal/with_replies"
    });

    const response = await app.inject({ method: "POST", url: `/jobs/${jobId}/retry` });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.verified).toBe(true);
    expect(body.replyUrl).toBe("https://x.com/personal/status/888");
    expect(body.job.status).toBe("posted");
  });

  it("reposts when the thread scan fails but the timeline shows the reply never landed", async () => {
    const { app, jobId } = await buildFailedJob();
    fetchTweet.mockRejectedValue(new Error("Timed out waiting for the target tweet to render"));
    fetchAccountTimeline.mockResolvedValue({ tweets: [], url: "https://x.com/personal/with_replies" });

    const response = await app.inject({ method: "POST", url: `/jobs/${jobId}/retry` });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().verified).toBe(false);
    expect(response.json().job.status).toBe("posted");
  });

  it("reposts through the gated path when the thread confirms the reply never landed", async () => {
    const { app, jobId } = await buildFailedJob();
    fetchTweet.mockResolvedValue({ tweet: tweet(), url: "https://x.com/home", replies: [] });

    const response = await app.inject({ method: "POST", url: `/jobs/${jobId}/retry` });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.verified).toBe(false);
    expect(body.job.status).toBe("posted");
  });

  it("refuses to act when both the thread and timeline scans fail", async () => {
    const { app, jobId } = await buildFailedJob();
    fetchTweet.mockRejectedValue(new Error("Chrome CDP is unavailable"));
    fetchAccountTimeline.mockRejectedValue(new Error("Chrome CDP is unavailable"));

    const response = await app.inject({ method: "POST", url: `/jobs/${jobId}/retry` });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/Cannot verify the target thread or the account timeline/);
  });

  it("refuses non-failed jobs with 409", async () => {
    const { app, repository, jobId } = await buildFailedJob();
    await repository.updateJobStatus(jobId, "approved");

    const response = await app.inject({ method: "POST", url: `/jobs/${jobId}/retry` });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/failed reply jobs only/);
  });
});
