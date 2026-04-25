import { describe, expect, it } from "vitest";
import { accountSchema, postJobSchema } from "./index.js";

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
});
