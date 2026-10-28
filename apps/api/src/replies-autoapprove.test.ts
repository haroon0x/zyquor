import { createSqliteRepository, type ZyquorRepository } from "@zyquor/storage";
import type { DraftGenerationProvider, GenerateDraftCandidatesInput } from "@zyquor/generation";
import type { XFeedTweet } from "@zyquor/browser";
import type { GoldfishContextBundle, GoldfishContextInput } from "@zyquor/adapters";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const accountId = "account_personal";
const freshIso = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

// Texts verified against the deterministic scorer: both pass the default
// floor of 7 (quality 9), the third is clean but scores 3 and must be held.
const PASSING_TEXT_A =
  "We replaced the on-call query cache after our benchmark hit 40 p95 misses per hour, because silent tail latency was costing real users.";
const PASSING_TEXT_B =
  "We queue every agent response behind a small benchmark this week, because silent regressions burned us twice and 3 releases slipped quietly.";
const SUBFLOOR_TEXT = "Great point, totally agree with you on this one!";

// Reply targets require digit-only tweet ids (replyTargetSchema), so the
// factory mints real numeric status ids while keeping readable author names.
let nextTweetId = 19801234567;
function tweet(overrides: Partial<XFeedTweet> = {}): XFeedTweet {
  const suffix = String(nextTweetId).slice(-2);
  const statusId = String(nextTweetId++);
  return {
    id: statusId,
    authorHandle: `fan_${suffix}`,
    authorName: `Fan ${suffix}`,
    text: `${suffix} says this product is interesting`,
    url: `https://x.com/fan_${suffix}/status/${statusId}`,
    publishedAt: freshIso(),
    isRetweet: false,
    ...overrides
  };
}

const generationInputs: GenerateDraftCandidatesInput[] = [];
const goldfishInputs: GoldfishContextInput[] = [];
let queuedReplies: string[] = [];
const generationProvider: DraftGenerationProvider = {
  name: "ollama",
  model: "test-local",
  async generateDraftCandidates(input) {
    generationInputs.push(input);
    const text = queuedReplies.length > 0 ? (queuedReplies.shift() as string) : "A plain neutral filler reply without any nuance.";
    // Production providers attach score.provider and pre-shape text, which the
    // lane's preserveCase check keys on, so mirror that exact shape here.
    return [{ text, score: { provider: "ollama", model: "test-local", rank: 1, quality: 9 } }];
  }
};

function goldfishBundle(memories: GoldfishContextBundle["memories"]): GoldfishContextBundle {
  return {
    terms: ["product"],
    wiki: [{ slug: "acme", title: "Acme Labs", type: "company", summary: "Developer tooling." }],
    memories
  };
}

// Wiki-only request (maxMemories 0) gets no activity excerpts, mirroring what
// fetchGoldfishReplyContext does with a zero memory limit.
function goldfishReplyContext(input: GoldfishContextInput): Promise<GoldfishContextBundle | null> {
  goldfishInputs.push(input);
  if (input.maxMemories === 0) {
    return Promise.resolve(goldfishBundle([]));
  }
  return Promise.resolve(
    goldfishBundle([
      { app: "mail", capturedAt: freshIso(), title: "Invoice thread", excerpt: "Activity excerpt that must never surface." }
    ])
  );
}

async function seedPostedMention(repository: ZyquorRepository, url: string) {
  const created = await repository.createDraft({
    accountId,
    sourceInput: "seeded posted draft",
    replyTo: { tweetId: "999000222", authorHandle: "fan_posted", url, authorName: "Fan posted", text: "posted text" }
  });
  await repository.createPostHistory({
    accountId,
    draftId: created.draft.id,
    postedText: "older reply text",
    postUrl: null,
    sourceType: "x-feed",
    sourceUrl: url,
    tweetType: "reply"
  });
}

async function seedDraftedMention(repository: ZyquorRepository, url: string) {
  await repository.createDraft({
    accountId,
    sourceInput: "seeded draft",
    replyTo: { tweetId: "999000111", authorHandle: "fan_seed", url, authorName: "Fan seed", text: "seed text" }
  });
}

// Seeds an auto-approved reply draft exactly as an earlier lane run today
// would have left it: autoApproved marker, selected candidate, approval job.
async function seedAutoApprovedToday(repository: ZyquorRepository, url: string, editedText: string) {
  const created = await repository.createDraft({
    accountId,
    sourceInput: "seeded earlier lane run",
    replyTo: { tweetId: "999000333", authorHandle: "fan_earlier", url, authorName: "Fan earlier", text: "earlier text" },
    metadata: { origin: "mention-scan", autoApproved: true }
  });
  await repository.saveDraftCandidates(created.draft.id, [
    { text: editedText, score: { provider: "ollama", model: "test-local", rank: 1, quality: 9 } }
  ]);
  return repository.approveDraft({ draftId: created.draft.id, editedText });
}

let fetchXMentions: ReturnType<typeof vi.fn>;
let fetchTweet: ReturnType<typeof vi.fn>;

const originalCap = process.env.ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP;
const originalQualityMin = process.env.ZYQUOR_QUALITY_MIN;

beforeEach(() => {
  generationInputs.length = 0;
  goldfishInputs.length = 0;
  queuedReplies = [];
  fetchXMentions = vi.fn();
  fetchTweet = vi.fn();
  delete process.env.ZYQUOR_QUALITY_MIN;
});

afterEach(() => {
  if (originalCap === undefined) {
    delete process.env.ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP;
  } else {
    process.env.ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP = originalCap;
  }
  if (originalQualityMin === undefined) {
    delete process.env.ZYQUOR_QUALITY_MIN;
  } else {
    process.env.ZYQUOR_QUALITY_MIN = originalQualityMin;
  }
});

async function buildTestApp() {
  const repository = await createSqliteRepository(":memory:");
  const app = buildApp({
    repository,
    generationProvider,
    fetchXMentions: fetchXMentions as never,
    fetchTweet: fetchTweet as never,
    goldfishReplyContext
  });
  return { app, repository };
}

describe("POST /replies/mentions/scan-and-auto-approve", () => {
  it("approves qualifying mentions up to the daily cap and holds the rest as queued drafts", async () => {
    process.env.ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP = "1";
    const first = tweet();
    const second = tweet();
    fetchXMentions.mockResolvedValue({ tweets: [first, second], url: "https://x.com/notifications/mentions" });
    queuedReplies = [PASSING_TEXT_A, PASSING_TEXT_B];

    const { app, repository } = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/replies/mentions/scan-and-auto-approve",
      payload: { accountId }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dailyCap).toBe(1);
    expect(body.approved).toHaveLength(1);
    expect(body.created).toHaveLength(2);
    expect(body.held).toEqual([{ url: second.url, reason: "daily_cap_reached" }]);
    expect(body.remainingToday).toBe(0);

    const approvedDraftId = body.approved[0].draftId;
    const approvedDraft = await repository.getDraft(approvedDraftId);
    expect(approvedDraft?.draft.status).toBe("approved");
    expect(approvedDraft?.draft.editedText).toBe(PASSING_TEXT_A);
    expect(approvedDraft?.draft.metadata.autoApproved).toBe(true);

    const jobs = await repository.listJobsByDraftId(approvedDraftId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.mode).toBe("review_required");
    expect(jobs[0]?.status).toBe("approved");
    expect(jobs[0]?.replyTo?.tweetId).toBe(first.id);

    // The cap-held draft stays in the review queue, untouched, with no job.
    const heldDraftId = body.created[1].draft.id;
    expect(body.created[1].draft.id).not.toBe(approvedDraftId);
    const heldDraft = await repository.getDraft(heldDraftId);
    expect(heldDraft?.draft.status).toBe("selected");
    expect(heldDraft?.draft.metadata.autoApproved).toBeUndefined();
    expect(await repository.listJobsByDraftId(heldDraftId)).toHaveLength(0);
  });

  it("holds sub-floor text in the review queue and approves nothing", async () => {
    const only = tweet();
    fetchXMentions.mockResolvedValue({ tweets: [only], url: "https://x.com/notifications/mentions" });
    queuedReplies = [SUBFLOOR_TEXT];

    const { app, repository } = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/replies/mentions/scan-and-auto-approve",
      payload: { accountId }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dailyCap).toBe(3);
    expect(body.approved).toEqual([]);
    expect(body.held).toEqual([{ url: only.url, reason: "quality_below_floor" }]);
    expect(body.created).toHaveLength(1);
    expect(body.created[0].draft.status).toBe("selected");

    const draftId = body.created[0].draft.id;
    const draft = await repository.getDraft(draftId);
    expect(draft?.draft.status).toBe("selected");
    expect(await repository.listJobsByDraftId(draftId)).toHaveLength(0);
  });

  it("drafts with wiki-only memory: activity excerpts never enter auto-approved text", async () => {
    const only = tweet();
    fetchXMentions.mockResolvedValue({ tweets: [only], url: "https://x.com/notifications/mentions" });
    queuedReplies = [PASSING_TEXT_A];

    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/replies/mentions/scan-and-auto-approve",
      payload: { accountId }
    });

    expect(response.statusCode).toBe(200);
    expect(bodyApprovedCount(response)).toBe(1);
    expect(goldfishInputs).toHaveLength(1);
    expect(goldfishInputs[0]?.maxMemories).toBe(0);
    const memoryContext = generationInputs[0]?.memoryContext as string | undefined;
    expect(typeof memoryContext).toBe("string");
    expect(memoryContext).toContain("Wiki [company] Acme Labs");
    expect(memoryContext).not.toContain("Activity (");
  });

  it("skips posted and already-drafted mentions so re-runs stay idempotent", async () => {
    const postedTweet = tweet();
    const draftedTweet = tweet();
    const fresh = tweet();
    fetchXMentions.mockResolvedValue({
      tweets: [postedTweet, draftedTweet, fresh],
      url: "https://x.com/notifications/mentions"
    });
    queuedReplies = [PASSING_TEXT_B];

    const { app, repository } = await buildTestApp();
    await seedPostedMention(repository, postedTweet.url);
    await seedDraftedMention(repository, draftedTweet.url);

    const response = await app.inject({
      method: "POST",
      url: "/replies/mentions/scan-and-auto-approve",
      payload: { accountId }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.skipped).toEqual([
      { url: postedTweet.url, reason: "posted" },
      { url: draftedTweet.url, reason: "drafted" }
    ]);
    expect(body.created).toHaveLength(1);
    expect(body.approved.map((entry: { url: string }) => entry.url)).toEqual([fresh.url]);
  });

  it("counts auto-approvals from earlier today against the cap", async () => {
    process.env.ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP = "1";
    const { app, repository } = await buildTestApp();
    const earlier = await seedAutoApprovedToday(repository, "https://x.com/fan_earlier/status/999000444", PASSING_TEXT_B);
    expect(earlier.job.status).toBe("approved");

    const fresh = tweet();
    fetchXMentions.mockResolvedValue({ tweets: [fresh], url: "https://x.com/notifications/mentions" });
    queuedReplies = [PASSING_TEXT_A];

    const response = await app.inject({
      method: "POST",
      url: "/replies/mentions/scan-and-auto-approve",
      payload: { accountId }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.dailyCap).toBe(1);
    expect(body.approved).toEqual([]);
    expect(body.held).toEqual([{ url: fresh.url, reason: "daily_cap_reached" }]);
    expect(body.remainingToday).toBe(0);
  });

  it("holds replies that pass the quality floor but exceed the tweet length limit", async () => {
    const only = tweet();
    fetchXMentions.mockResolvedValue({ tweets: [only], url: "https://x.com/notifications/mentions" });
    queuedReplies = [
      "We replaced the on-call query cache after our benchmark hit 40 p95 misses per hour, because silent tail latency was costing real users. The same fix also trimmed the embedding window and moved the dataset slice into memory, so every query under the new index re-ran in under 10 milliseconds without touching throughput numbers that the team relies on weekly."
    ];

    const { app, repository } = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/replies/mentions/scan-and-auto-approve",
      payload: { accountId }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.approved).toEqual([]);
    expect(body.held[0]?.reason).toMatch(/^too_long: \d+ chars$/);
    // The draft and its candidates stay queued for a human to trim.
    expect(body.created).toHaveLength(1);
    const draft = await repository.getDraft(body.created[0].draft.id);
    expect(draft?.draft.status).toBe("selected");
    expect(await repository.listJobsByDraftId(body.created[0].draft.id)).toHaveLength(0);
  });

  it("answers with 502 when the mentions tab cannot be read", async () => {
    fetchXMentions.mockRejectedValue(new Error("mentions tab unavailable"));
    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/replies/mentions/scan-and-auto-approve",
      payload: { accountId }
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toContain("mentions tab unavailable");
  });
});

function bodyApprovedCount(response: { json(): { approved: unknown[] } }): number {
  return response.json().approved.length;
}
