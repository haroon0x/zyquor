import { createSqliteRepository } from "@zyquor/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDailyLimitReached } from "./lib/daily-limit.js";

const accountId = "account_personal";

// Creates n post-history rows dated today so postsToday counts them.
async function seedPosts(repository: Awaited<ReturnType<typeof createSqliteRepository>>, count: number) {
  for (let index = 0; index < count; index += 1) {
    const draft = await repository.createDraft({
      accountId,
      sourceInput: `daily limit draft ${index}`,
      candidates: [{ text: `reached text ${index}`, score: {} }]
    });
    await repository.createPostHistory({
      accountId,
      draftId: draft.draft.id,
      postedText: `reached text ${index}`,
      postUrl: `https://x.com/personal/status/${1000 + index}`
    });
  }
}

describe("daily post ceiling", () => {
  const VARS = ["ZYQUOR_DAILY_POST_CEILING", "ZYQUOR_DAILY_POST_VARIANCE_MIN", "ZYQUOR_DAILY_POST_VARIANCE_MAX"] as const;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const name of VARS) saved.set(name, process.env[name]);
    for (const name of VARS) delete process.env[name];
  });

  afterEach(() => {
    for (const name of VARS) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("keeps the conservative default ceiling of 4 when no env overrides exist", async () => {
    const repository = await createSqliteRepository(":memory:");
    await seedPosts(repository, 4);
    // Default variance band (2..4) is clamped by the default ceiling of 4, so
    // 4 posts today always trips the limit no matter which day-seed was picked.
    await expect(isDailyLimitReached(repository, accountId, 300)).resolves.toBe(true);
  });

  it("honors a raised ceiling: 50 flat when band and ceiling are both set to 50", async () => {
    process.env.ZYQUOR_DAILY_POST_CEILING = "50";
    process.env.ZYQUOR_DAILY_POST_VARIANCE_MIN = "50";
    process.env.ZYQUOR_DAILY_POST_VARIANCE_MAX = "50";
    const repository = await createSqliteRepository(":memory:");
    await seedPosts(repository, 4);
    await expect(isDailyLimitReached(repository, accountId, 300)).resolves.toBe(false);
    await seedPosts(repository, 46);
    await expect(isDailyLimitReached(repository, accountId, 300)).resolves.toBe(true);
  });

  it("leaves the variance band alone when only the ceiling is raised", async () => {
    process.env.ZYQUOR_DAILY_POST_CEILING = "50";
    const repository = await createSqliteRepository(":memory:");
    await seedPosts(repository, 5);
    // Only MAX raised would unlock day 5; the default band 2..4 must still
    // trip it, proving the ceiling raise does not itself widen the band.
    await expect(isDailyLimitReached(repository, accountId, 300)).resolves.toBe(true);
  });
});
