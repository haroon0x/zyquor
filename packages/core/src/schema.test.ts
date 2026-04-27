import { describe, expect, it } from "vitest";
import {
  X_FREE_POST_CHARACTER_LIMIT,
  accountSchema,
  approveDraftRequestSchema,
  createDraftBatchRequestSchema,
  createDraftRequestSchema,
  postJobSchema
} from "./index.js";

const timestamp = "2026-04-24T17:30:00.000Z";

describe("domain schemas", () => {
  it("accepts an explicit prepare-only account config", () => {
    expect(() =>
      accountSchema.parse({
        id: "account_personal",
        handle: "example",
        displayName: "Example",
        profileDir: "profiles/personal-main",
        styleProfileId: "style_default",
        postingMode: "prepare_only",
        enabled: true,
        dailyPostLimit: 3,
        quietHoursStart: null,
        quietHoursEnd: null,
        createdAt: timestamp,
        updatedAt: timestamp
      })
    ).not.toThrow();
  });

  it("rejects unsupported job statuses", () => {
    expect(() =>
      postJobSchema.parse({
        id: "job_1",
        accountId: "account_personal",
        draftId: "draft_1",
        status: "done",
        mode: "prepare_only",
        scheduledFor: null,
        approvedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      })
    ).toThrow();
  });

  it("accepts tweet type options for single and batch drafting", () => {
    expect(
      createDraftRequestSchema.parse({
        accountId: "account_personal",
        idea: "Explain why local automation needs logs.",
        tweetType: "guide"
      })
    ).toMatchObject({ tweetType: "guide" });

    expect(
      createDraftBatchRequestSchema.parse({
        accountId: "account_personal",
        ideas: ["One", "Two"],
        scheduleSpacingMinutes: 90,
        scheduleStart: "2026-04-25T15:30:00.000Z",
        tweetType: "reply"
      })
    ).toMatchObject({ ideas: ["One", "Two"], tweetType: "reply" });
  });

  it("enforces the X free-tier post character limit", () => {
    expect(() =>
      approveDraftRequestSchema.parse({
        editedText: "x".repeat(X_FREE_POST_CHARACTER_LIMIT + 1)
      })
    ).toThrow();
  });
});
