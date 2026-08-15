import { withPostPerformance } from "@zyquor/core";
import { createMemoryRepository } from "@zyquor/storage";
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
    const repository = createMemoryRepository({ now: () => "2026-04-24T17:00:00.000Z" });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: "draft_1",
      metadata: withPostPerformance({}, { views: 120, likes: 2, replies: 1, reposts: 0, bookmarks: 0, measuredAt: "2026-04-24T16:00:00.000Z" }),
      postedText: "news post one",
      postUrl: "https://x.com/personal/status/1",
      sourceType: "news",
      sourcePacketId: "packet_1",
      tweetType: "article_summary"
    });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: "draft_2",
      metadata: withPostPerformance({}, { views: 40, likes: 0, replies: 0, reposts: 0, bookmarks: 0, measuredAt: "2026-04-24T16:00:00.000Z" }),
      postedText: "news post two",
      postUrl: "https://x.com/personal/status/2",
      sourceType: "news",
      sourcePacketId: "packet_2",
      tweetType: "article_summary"
    });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: "draft_3",
      metadata: {},
      postedText: "x-feed post",
      postUrl: "https://x.com/personal/status/3",
      sourceType: "x-feed",
      sourcePacketId: "packet_3",
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