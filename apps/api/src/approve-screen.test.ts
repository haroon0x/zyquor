import { createSqliteRepository } from "@zyquor/storage";
import type { DraftGenerationProvider, GenerateDraftCandidatesInput } from "@zyquor/generation";
import type { XFeedTweet } from "@zyquor/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const accountId = "account_personal";

// Fixtures verified against scoreTweetQuality/isCleanTweetText so each case
// isolates exactly one screen reason.
const PASSING_TEXT =
  "We replaced the on-call query cache after our benchmark hit 40 p95 misses per hour, because silent tail latency was costing real users.";
const SUBFLOOR_TEXT = "Great point, totally agree with you on this one!"; // clean, quality 3
const UNCLEAN_TEXT =
  "We shipped 40 retries with backoff tonight after our benchmark hit 10 p95 misses, because users churned twice and on-call burned 3 weekends; honestly it is a real game changer for the whole team."; // quality 7, slop phrase
const TOO_LONG_TEXT =
  "We replaced the on-call query cache after our benchmark hit 40 p95 misses per hour, because silent tail latency was costing real users. We queue every agent response behind a small benchmark this week, because silent regressions burned us twice and 3 releases slipped quietly. The same benchmark now guards the embedding index rebuild as well, because a stale index shipped 2 weeks ago started returning 5 disconnected results per day."; // quality 9, 435 chars

function tweet(): XFeedTweet {
  const statusId = "19801234501";
  return {
    id: statusId,
    authorHandle: "screen_fan",
    authorName: "Screen Fan",
    text: "screen_test says this product is interesting",
    url: `https://x.com/screen_fan/status/${statusId}`,
    publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    isRetweet: false
  };
}

const generationProvider: DraftGenerationProvider = {
  name: "ollama",
  model: "test-local",
  async generateDraftCandidates(input) {
    // Best-of-N aware: hand back as many texts as were requested so the
    // from-url count threading is observable end to end.
    const candidates = [];
    for (let index = 0; index < (input.count ?? 1); index += 1) {
      candidates.push({
        text: `${PASSING_TEXT} Candidate ${index + 1}.`,
        score: { provider: "ollama", model: "test-local", rank: index + 1, quality: 9 }
      });
    }
    return candidates;
  }
};

let fetchTweet: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchTweet = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildTestApp() {
  const repository = await createSqliteRepository(":memory:");
  const app = buildApp({
    repository,
    generationProvider,
    fetchTweet: fetchTweet as never
  });
  return { app, repository };
}

// Seeds a selected draft the way from-url does, returning its id.
describe("POST /drafts/:id/approve screened mode", () => {
  async function approveScreened(url: string, text: string, payload: Record<string, unknown>) {
    const { app } = await buildTestApp();
    fetchTweet.mockResolvedValue({ tweet: tweet(), url: "https://x.com/home" });
    const created = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId, url, useMemory: false }
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    return app.inject({
      method: "POST",
      url: `/drafts/${createdBody.draft.id}/approve`,
      payload: { editedText: text, ...payload }
    });
  }

  it("approves clean text that passes the quality floor when screened is true", { timeout: 15000 }, async () => {
    const response = await approveScreened(tweet().url, PASSING_TEXT, { screened: true });
    expect(response.statusCode).toBe(201);
  });

  // Approves a plain text draft (no reply metadata) so the screen must apply
  // the full post floor.
  async function approvePostScreened(text: string, payload: Record<string, unknown>) {
    const { app } = await buildTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/drafts",
      payload: { accountId, idea: "Post about engineering tradeoffs", tweetType: "useful_info" }
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    return app.inject({
      method: "POST",
      url: `/drafts/${createdBody.draft.id}/approve`,
      payload: { editedText: text, ...payload }
    });
  }

  it("rejects text below the quality floor with 409 when screened is true", async () => {
    const response = await approveScreened(tweet().url, SUBFLOOR_TEXT, { screened: true });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/Approval screen failed/);
    // from-url drafts are reply drafts, so the screen applies the reply floor.
    expect(response.json().error).toMatch(/quality 3 below floor 5/);
  });

  it("screens reply drafts against the reply floor, not the post floor", async () => {
    // Clean one-line reply carrying a payoff signal scores 6, under the post
    // floor of 7 but at or above the reply floor of 5.
    const replyText = "Smoking lost eventually because the cost lands in a dataset. Cancer rates, death certificates. Not reading leaves nothing behind, the loss is the ideas you never worked out, and nobody tracks that.";
    const response = await approveScreened(tweet().url, replyText, { screened: true });
    expect(response.statusCode).toBe(201);
  });

  it("keeps the full post floor for non-reply drafts even when a reply would pass", async () => {
    // Same quality-6 text, but the draft was created through the post lane,
    // and the post floor must not silently drop to the reply floor for it.
    const replyText = "Smoking lost eventually because the cost lands in a dataset. Cancer rates, death certificates. Not reading leaves nothing behind, the loss is the ideas you never worked out, and nobody tracks that.";
    const response = await approvePostScreened(replyText, { screened: true });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/quality 6 below floor 7/);
  });

  it("rejects unclean text with 409 even when the numeric score passes", async () => {
    const response = await approveScreened(tweet().url, UNCLEAN_TEXT, { screened: true });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/unclean text/);
  });

  it("rejects text over the tweet length limit with 409", async () => {
    const response = await approveScreened(tweet().url, TOO_LONG_TEXT, { screened: true });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/too_long \(435 chars > 279\)/);
  });

  it("lets a human approve sub-floor text without screened, preserving the override path", async () => {
    const response = await approveScreened(tweet().url, SUBFLOOR_TEXT, {});
    expect(response.statusCode).toBe(201);
  });

  it("keeps a screened draft untouched and jobless after a failed screen", async () => {
    const { app, repository } = await buildTestApp();
    fetchTweet.mockResolvedValue({ tweet: tweet(), url: "https://x.com/home" });
    const created = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId, url: tweet().url, useMemory: false }
    });
    const draftId = created.json().draft.id;
    const failed = await app.inject({
      method: "POST",
      url: `/drafts/${draftId}/approve`,
      payload: { editedText: SUBFLOOR_TEXT, screened: true }
    });
    expect(failed.statusCode).toBe(409);
    const after = await repository.getDraft(draftId);
    expect(after?.draft.status).toBe("selected");
    const jobs = await repository.listJobsByDraftId(draftId);
    expect(jobs).toHaveLength(0);
  });
});

describe("POST /replies/from-url best-of-N count", () => {
  it("generates the requested number of candidates when count is 2", async () => {
    const { app, repository } = await buildTestApp();
    fetchTweet.mockResolvedValue({ tweet: tweet(), url: "https://x.com/home" });
    const response = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId, url: tweet().url, count: 2, useMemory: false }
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.draft.metadata.count).toBe(2);
    expect(body.candidates).toHaveLength(2);
    const draftId = body.draft.id;
    const stored = await repository.getDraft(draftId);
    // persisted.toEqual 2 candidates on the draft, one auto-selected (rank 1).
    expect(stored?.candidates).toHaveLength(2);
    expect(stored?.candidates.filter((candidate) => candidate.selected)).toHaveLength(1);
  });

  it("defaults to one candidate when count is omitted", async () => {
    const { app } = await buildTestApp();
    fetchTweet.mockResolvedValue({ tweet: tweet(), url: "https://x.com/home" });
    const response = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId, url: tweet().url, useMemory: false }
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().candidates).toHaveLength(1);
  });

  it("threads counts past the old cap through to metadata", async () => {
    const { app } = await buildTestApp();
    fetchTweet.mockResolvedValue({ tweet: tweet(), url: "https://x.com/home" });
    const response = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId, url: tweet().url, count: 4, useMemory: false }
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().draft.metadata.count).toBe(4);
  });

  it("rejects counts outside 1..50 with 400", async () => {
    const { app } = await buildTestApp();
    fetchTweet.mockResolvedValue({ tweet: tweet(), url: "https://x.com/home" });
    const response = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId, url: tweet().url, count: 51 }
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /replies/from-url existing replies context", () => {
  it("threads replies already posted under the target into generation and metadata", async () => {
    const captured: GenerateDraftCandidatesInput[] = [];
    const provider: DraftGenerationProvider = {
      name: "ollama",
      model: "test-local",
      async generateDraftCandidates(input) {
        captured.push(input);
        return [{ text: PASSING_TEXT, score: { provider: "ollama", model: "test-local", rank: 1, quality: 9 } }];
      }
    };
    const repository = await createSqliteRepository(":memory:");
    const app = buildApp({ repository, generationProvider: provider, fetchTweet: fetchTweet as never });
    const replyOne = { ...tweet(), id: "19801234511", url: "https://x.com/screen_fan/status/19801234511", text: "just use datadog" };
    const replyTwo = { ...tweet(), id: "19801234512", url: "https://x.com/screen_fan/status/19801234512", text: "The answer is a dashboard nobody opens." };
    fetchTweet.mockResolvedValue({ tweet: tweet(), url: "https://x.com/home", replies: [replyOne, replyTwo] });

    const response = await app.inject({
      method: "POST",
      url: "/replies/from-url",
      payload: { accountId, url: tweet().url, useMemory: false }
    });

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json();
    expect(body.draft.metadata.sourceReplies).toBe(2);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.replyContext?.otherReplies).toEqual([
      "just use datadog",
      "The answer is a dashboard nobody opens."
    ]);
    expect(body.candidates).toHaveLength(1);
  });
});
