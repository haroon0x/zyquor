import { withPostPerformance } from "@zyquor/core";
import { createSqliteRepository } from "@zyquor/storage";
import { describe, expect, it } from "vitest";
import { engagementPerPostOf, sourcePerformanceByType } from "./performance.js";

describe("source performance feedback", () => {
  it("weights engagement per the x-algorithm action values", () => {
    expect(engagementPerPostOf({ posts: 1, likes: 1, replies: 0, reposts: 0 })).toBe(1);
    expect(engagementPerPostOf({ posts: 1, likes: 0, replies: 1, reposts: 0 })).toBe(10);
    expect(engagementPerPostOf({ posts: 1, likes: 0, replies: 0, reposts: 1 })).toBe(2);
    expect(engagementPerPostOf({ posts: 2, likes: 1, replies: 1, reposts: 0 })).toBe(5.5);
    expect(engagementPerPostOf({ posts: 0, likes: 5, replies: 0, reposts: 0 })).toBe(0);
  });

  it("aggregates measured posts by source type and skips unmeasured history", async () => {
    const repository = await createSqliteRepository(":memory:");
    // SQLite enforces the post_history -> drafts foreign key, so back each
    // history row with a real draft.
    const drafts = [];
    for (const [index, sourceInput] of [
      "news post one",
      "news post two",
      "x-feed post"
    ].entries()) {
      const created = await repository.createDraft({
        accountId: "account_personal",
        sourceInput,
        candidates: [{ text: `${sourceInput} text`, score: {} }]
      });
      drafts.push(created.draft.id);
      await repository.approveDraft({
        draftId: created.draft.id,
        editedText: `${sourceInput} text`
      });
    }

    const performance = (views: number, likes: number, replies = 0) =>
      withPostPerformance({}, { views, likes, replies, reposts: 0, bookmarks: 0, measuredAt: new Date().toISOString() });

    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: drafts[0]!,
      metadata: performance(120, 2, 1),
      postedText: "news post one text",
      postUrl: "https://x.com/personal/status/1",
      sourceType: "news",
      tweetType: "useful_info"
    });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: drafts[1]!,
      metadata: performance(40, 0),
      postedText: "news post two text",
      postUrl: "https://x.com/personal/status/2",
      sourceType: "news",
      tweetType: "useful_info"
    });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: drafts[2]!,
      metadata: {},
      postedText: "x-feed post text",
      postUrl: "https://x.com/personal/status/3",
      sourceType: "x-feed",
      tweetType: "useful_info"
    });

    const result = await sourcePerformanceByType(repository);
    expect(result.has("x-feed")).toBe(false);
    expect(result.get("news")).toMatchObject({
      sourceType: "news",
      posts: 2,
      viewsAvg: 80,
      engagementPerPost: 6
    });
  });
});