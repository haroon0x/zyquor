import { createSqliteRepository, type ZyquorRepository } from "@zyquor/storage";
import type { DraftGenerationProvider, GenerateDraftCandidatesInput } from "@zyquor/generation";
import type { XFeedTweet } from "@zyquor/browser";
import type { GoldfishContextBundle } from "@zyquor/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

const accountId = "account_personal";
const freshIso = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const oldIso = () => new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

// Reply targets require digit-only tweet ids (replyTargetSchema), so the
// factory mints real numeric status ids while keeping readable author names.
let nextTweetId = 18901234567;
function tweet(id: string, overrides: Partial<XFeedTweet> = {}): XFeedTweet {
  const statusId = String(nextTweetId++);
  return {
    id: statusId,
    authorHandle: `fan_${id}`.slice(0, 15),
    authorName: `Fan ${id}`,
    text: `${id} says this product is interesting`,
    url: `https://x.com/fan_${id}/status/${statusId}`,
    publishedAt: freshIso(),
    isRetweet: false,
    ...overrides
  };
}

const generationInputs: GenerateDraftCandidatesInput[] = [];
const generationProvider: DraftGenerationProvider = {
  name: "ollama",
  model: "test-local",
  async generateDraftCandidates(input) {
    generationInputs.push(input);
    return [{ text: "A grounded reply to the mention.", score: { quality: 5 } }];
  }
};

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

let fetchXMentions: ReturnType<typeof vi.fn>;
let fetchTweet: ReturnType<typeof vi.fn>;

beforeEach(() => {
  generationInputs.length = 0;
  fetchXMentions = vi.fn();
  fetchTweet = vi.fn();
});

function goldfishBundle(): GoldfishContextBundle {
  return {
    terms: ["product"],
    wiki: [{ slug: "acme", title: "Acme Labs", type: "company", summary: "Developer tooling." }],
    memories: []
  };
}

async function buildTestApp() {
  const repository = await createSqliteRepository(":memory:");
  const app = buildApp({
    repository,
    generationProvider,
    fetchXMentions: fetchXMentions as never,
    fetchTweet: fetchTweet as never,
    goldfishReplyContext: async () => goldfishBundle()
  });
  return { app, repository };
}

describe("GET /replies/mentions", () => {
  it("filters the window, dedupes, skips promoted, and annotates drafted/posted", async () => {
    const freshA = tweet("a");
    const freshB = tweet("b");
    const freshC = tweet("c2");
    const stale = tweet("stale", { publishedAt: oldIso() });
    const promoted = tweet("promoted", { isPromoted: true });
    fetchXMentions.mockResolvedValue({
      tweets: [freshA, freshA, freshB, freshC, stale, promoted],
      url: "https://x.com/notifications/mentions"
    });

    const { app, repository } = await buildTestApp();
    await seedPostedMention(repository, freshA.url);
    await seedDraftedMention(repository, freshB.url);

    const response = await app.inject({ method: "GET", url: `/replies/mentions?accountId=${accountId}` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.scanned).toBe(6);
    expect(body.adsSkipped).toBe(1);
    const urls = body.mentions.map((item: { url: string }) => item.url);
    expect(urls).toEqual([freshA.url, freshB.url, freshC.url]);
    expect(body.mentions[0]).toMatchObject({ drafted: false, posted: true });
    expect(body.mentions[1]).toMatchObject({ drafted: true, posted: false });
    expect(body.mentions[2]).toMatchObject({ drafted: false, posted: false });
  });

  it("answers with 502 when the mentions tab cannot be read", async () => {
    fetchXMentions.mockRejectedValue(new Error("mentions tab unavailable"));
    const { app } = await buildTestApp();
    const response = await app.inject({ method: "GET", url: `/replies/mentions?accountId=${accountId}` });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toContain("mentions tab unavailable");
  });
});

describe("POST /replies/mentions/scan-and-draft", () => {
  it("drafts only fresh, not-yet-drafted mentions and caps creates at ten per call", async () => {
    const fresh: XFeedTweet[] = Array.from({ length: 12 }, (_, index) => tweet(`s${index}`));
    fetchXMentions.mockResolvedValue({ tweets: fresh, url: "https://x.com/notifications/mentions" });

    const { app } = await buildTestApp();
    const first = await app.inject({
      method: "POST",
      url: "/replies/mentions/scan-and-draft",
      payload: { accountId }
    });

    expect(first.statusCode).toBe(200);
    const firstBody = first.json();
    expect(firstBody.created).toHaveLength(10);
    // The cap breaks before the last two fresh items are evaluated, so run 1
    // has no skips yet.
    expect(firstBody.skipped).toEqual([]);
    expect(firstBody.scanned).toBe(12);
    const createdMetadata = firstBody.created[0].draft as { metadata: { origin?: string } };
    expect(createdMetadata.metadata.origin).toBe("mention-scan");
    expect(generationInputs).toHaveLength(10);
    expect(generationInputs[0]?.memoryContext).toContain("Acme Labs");
    expect(generationInputs[0]?.tweetType).toBe("reply");

    // The remaining two fresh mentions get drafted on the next call, and the
    // ten already drafted ones are skipped; nothing is drafted twice.
    const second = await app.inject({
      method: "POST",
      url: "/replies/mentions/scan-and-draft",
      payload: { accountId }
    });
    const secondBody = second.json();
    expect(secondBody.created).toHaveLength(2);
    expect(secondBody.skipped).toHaveLength(10);
    expect(secondBody.skipped.every((item: { reason: string }) => item.reason === "drafted")).toBe(true);

    const again = await app.inject({
      method: "POST",
      url: "/replies/mentions/scan-and-draft",
      payload: { accountId }
    });
    const againBody = again.json();
    expect(againBody.created).toHaveLength(0);
    expect(againBody.skipped).toHaveLength(12);
  });

  it("posts nothing anywhere by design: drafts join the review queue for approval", async () => {
    const fresh = [tweet("single")];
    fetchXMentions.mockResolvedValue({ tweets: fresh, url: "https://x.com/notifications/mentions" });

    const { app, repository } = await buildTestApp();
    await app.inject({ method: "POST", url: "/replies/mentions/scan-and-draft", payload: { accountId } });
    const drafts = await repository.listDrafts(accountId);

    expect(drafts).toHaveLength(1);
    // A scanned mention produces an approvable draft; nothing is posted and
    // no history or job exists for it.
    expect(drafts[0]?.status).toBe("selected");
    expect(drafts[0]?.replyTo?.url).toBe(fresh[0]!.url);
    expect(await repository.countPostHistoryByDraftId(drafts[0]!.id)).toBe(0);
  });
});

describe("POST /replies/mentions/draft", () => {
  it("reuses the scan when possible, falls back to fetchTweet, and reports skips", async () => {
    const scanned = tweet("a");
    const fetched = tweet("b");
    const unavailable = tweet("c3");
    fetchXMentions.mockResolvedValue({ tweets: [scanned], url: "https://x.com/notifications/mentions" });
    fetchTweet.mockImplementation((input: { url: string }) =>
      input.url === fetched.url ? { tweet: fetched, url: fetched.url } : Promise.reject(new Error("404"))
    );

    const { app } = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/replies/mentions/draft",
      payload: {
        accountId,
        mentions: [{ url: scanned.url }, { url: fetched.url }, { url: unavailable.url }]
      }
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.created).toHaveLength(2);
    expect(body.skipped).toEqual([{ url: unavailable.url, reason: "unavailable" }]);
  });

  it("skips an already-posted mention with reason posted", async () => {
    const posted = tweet("posted");
    fetchXMentions.mockResolvedValue({ tweets: [posted], url: "https://x.com/notifications/mentions" });

    const { app, repository } = await buildTestApp();
    await seedPostedMention(repository, posted.url);

    const response = await app.inject({
      method: "POST",
      url: "/replies/mentions/draft",
      payload: { accountId, mentions: [{ url: posted.url }] }
    });

    const body = response.json();
    expect(body.created).toEqual([]);
    expect(body.skipped).toEqual([{ url: posted.url, reason: "posted" }]);
  });

  it("does not scan once the mention is already drafted (dedupe across formats)", async () => {
    const canonical = tweet("tw");
    const tweeted = { ...canonical, url: canonical.url.replace("https://x.com", "https://twitter.com") };
    fetchXMentions.mockResolvedValue({ tweets: [canonical], url: "https://x.com/notifications/mentions" });

    const { app, repository } = await buildTestApp();
    await seedDraftedMention(repository, tweeted.url);

    const response = await app.inject({
      method: "POST",
      url: "/replies/mentions/draft",
      payload: { accountId, mentions: [{ url: canonical.url }] }
    });

    const body = response.json();
    expect(body.created).toEqual([]);
    expect(body.skipped).toEqual([{ url: canonical.url, reason: "drafted" }]);
    expect(fetchTweet).not.toHaveBeenCalled();
  });
});
