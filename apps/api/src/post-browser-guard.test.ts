import { createSqliteRepository, type ZyquorRepository } from "@zyquor/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { resolveProfileDir } from "./lib/paths.js";

const { readCdpLaunchState } = vi.hoisted(() => ({
  readCdpLaunchState: vi.fn<() => { profileDir: string; pid: number | null } | null>(() => null)
}));

vi.mock("@zyquor/browser", () => ({
  readCdpLaunchState,
  closeBrowserCdp: vi.fn(async () => undefined)
}));

beforeEach(() => {
  process.env.ZYQUOR_POST_GAP_MIN_MINUTES = "0";
  readCdpLaunchState.mockReset();
  readCdpLaunchState.mockReturnValue(null);
});

async function createApprovedJob(repository: ZyquorRepository) {
  const created = await repository.createDraft({
    accountId: "account_personal",
    sourceInput: "Guard test idea",
    candidates: [{ text: "Guard test post text", score: {} }]
  });
  return repository.approveDraft({
    draftId: created.draft.id,
    editedText: "Guard test post text"
  });
}

describe("postBrowserJob single-account guard", () => {
  it("rejects the post when the recorded posting Chrome carries another profile", async () => {
    const repository = await createSqliteRepository(":memory:");
    const preparePost = vi.fn(async () => ({ postUrl: "https://x.com/personal/status/1" }));
    const app = buildApp({ repository, preparePost, enableBrowserPost: true });
    const approved = await createApprovedJob(repository);

    readCdpLaunchState.mockReturnValue({
      profileDir: "/tmp/other-data-root/profiles/someone-else",
      pid: null
    });

    const response = await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("Only one account can post at a time")
    });
    expect(preparePost).not.toHaveBeenCalled();
    // The guard runs before the job is claimed, so it stays approved.
    await expect(repository.getJob(approved.job.id)).resolves.toMatchObject({ status: "approved" });

    await app.close();
  });

  it("posts normally when no launch state is recorded", async () => {
    const repository = await createSqliteRepository(":memory:");
    const preparePost = vi.fn(async () => ({ postUrl: "https://x.com/personal/status/2" }));
    const app = buildApp({ repository, preparePost, enableBrowserPost: true });
    const approved = await createApprovedJob(repository);

    readCdpLaunchState.mockReturnValue(null);

    const response = await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` });

    expect(response.statusCode).toBe(200);
    expect(preparePost).toHaveBeenCalledTimes(1);
    await expect(repository.getJob(approved.job.id)).resolves.toMatchObject({ status: "posted" });

    await app.close();
  });

  it("posts normally when the recorded launch state matches the job account", async () => {
    const repository = await createSqliteRepository(":memory:");
    const account = await repository.getAccount("account_personal");
    expect(account).not.toBeNull();
    const preparePost = vi.fn(async () => ({ postUrl: "https://x.com/personal/status/3" }));
    const app = buildApp({ repository, preparePost, enableBrowserPost: true });
    const approved = await createApprovedJob(repository);

    readCdpLaunchState.mockReturnValue({
      profileDir: resolveProfileDir(account!.profileDir),
      pid: null
    });

    const response = await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` });

    expect(response.statusCode).toBe(200);
    expect(preparePost).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
