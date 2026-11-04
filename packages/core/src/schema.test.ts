import { describe, expect, it } from "vitest";
import {
  accountSchema,
  createAccountRequestSchema,
  createDraftBatchRequestSchema,
  createDraftRequestSchema,
  createSourcePacketRequestSchema,
  draftSchema,
  parseReplyTargetUrl,
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

  it("derives safe account creation defaults", () => {
    expect(createAccountRequestSchema.parse({ handle: "example_user" })).toEqual({
      handle: "example_user",
      displayName: "example_user",
      profileDir: "profiles/example_user"
    });
    expect(createAccountRequestSchema.parse({ handle: "example", displayName: "Example" })).toMatchObject({
      displayName: "Example"
    });
  });

  it.each(["@example", "Example", "example-user", "example user", "abcdefghijklmnop"])(
    "rejects invalid account handle %s",
    (handle) => {
      expect(() => createAccountRequestSchema.parse({ handle })).toThrow();
    }
  );

  it("rejects a user-supplied account profile directory", () => {
    expect(() => createAccountRequestSchema.parse({ handle: "example", profileDir: "profiles/other" })).toThrow();
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

  it("validates reply targets on drafts and jobs", () => {
    const replyTo = {
      tweetId: "1891234567890123456",
      authorHandle: "example_user",
      url: "https://x.com/example_user/status/1891234567890123456"
    };
    const base = {
      id: "draft_1",
      accountId: "account_personal",
      sourceType: "text",
      sourceInput: "A reply",
      generatedText: null,
      editedText: null,
      metadata: {},
      status: "created",
      createdAt: timestamp,
      updatedAt: timestamp
    };

    expect(draftSchema.parse({ ...base, replyTo })).toMatchObject({ replyTo });
    expect(
      postJobSchema.parse({
        id: "job_1",
        accountId: "account_personal",
        draftId: "draft_1",
        replyTo,
        status: "approved",
        mode: "prepare_only",
        scheduledFor: null,
        approvedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      })
    ).toMatchObject({ replyTo });
    expect(() => draftSchema.parse({ ...base, replyTo: { ...replyTo, tweetId: "not-a-tweet-id" } })).toThrow();
  });

  it.each([
    ["https://x.com/example/status/1891234567890123456", "example", "1891234567890123456"],
    ["https://twitter.com/example_user/status/12345?s=20", "example_user", "12345"]
  ])("parses reply target URL %s", (url, authorHandle, tweetId) => {
    expect(parseReplyTargetUrl(url)).toEqual({ url, authorHandle, tweetId });
  });

  it.each([
    "http://x.com/example/status/12345",
    "https://example.com/example/status/12345",
    "https://x.com/example/status/not-a-number",
    "https://x.com/example/status/12345/extra",
    "https://x.com/home",
    "not a URL"
  ])("rejects non-status reply target URL %s", (url) => {
    expect(parseReplyTargetUrl(url)).toBeNull();
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
        tweetType: "guide"
      })
    ).toMatchObject({ ideas: ["One", "Two"], tweetType: "guide" });
  });

  it("accepts job source packets and rejected legacy tweet types", () => {
    expect(
      createSourcePacketRequestSchema.parse({
        accountId: "account_personal",
        sourceType: "job",
        summary: "Company is hiring infra engineers.",
        title: "ExampleCo is hiring",
        tweetType: "useful_info",
        url: "https://example.com/jobs/infra"
      })
    ).toMatchObject({ sourceType: "job", tweetType: "useful_info" });

    // The five legacy types were retired; they must no longer validate.
    for (const retired of ["article_summary", "news_context", "lesson", "tool", "hiring"]) {
      expect(
        createDraftRequestSchema.safeParse({
          accountId: "account_personal",
          idea: "Read this blog post and summarize why it matters.",
          tweetType: retired
        }).success
      ).toBe(false);
    }
  });

});
