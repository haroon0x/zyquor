import { createSqliteRepository, type ZyquorRepository } from "@zyquor/storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { resolveProfileDir } from "./lib/paths.js";

const { readCdpLaunchState, readAllCdpLaunchStates } = vi.hoisted(() => ({
  readCdpLaunchState: vi.fn<() => { profileDir: string; pid: number | null } | null>(() => null),
  readAllCdpLaunchStates: vi.fn<() => Array<{ profileDir: string; pid: number | null }>>(() => []),
}));

vi.mock("@zyquor/browser", () => ({
  readCdpLaunchState,
  readAllCdpLaunchStates,
  closeBrowserCdp: vi.fn(async () => undefined),
  checkXLogin: vi.fn(async () => ({ loggedIn: true, handle: "personal-main", url: "https://x.com/home" })),
  ensureBrowserCdp: vi.fn(async () => true),
}));

beforeEach(() => {
  process.env.ZYQUOR_POST_GAP_MIN_MINUTES = "0";
  readCdpLaunchState.mockReset();
  readCdpLaunchState.mockReturnValue(null);
  readAllCdpLaunchStates.mockReset();
  readAllCdpLaunchStates.mockReturnValue([]);
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

describe("postBrowserJob per-profile concurrency", () => {
  it("allows posting even when another profile is recorded on a different port", async () => {
    const repository = await createSqliteRepository(":memory:");
    const preparePost = vi.fn(async () => ({ postUrl: "https://x.com/personal/status/1" }));
    const app = buildApp({ repository, preparePost, enableBrowserPost: true, checkXLogin: vi.fn(async () => ({ loggedIn: true, handle: "personal-main", url: "https://x.com/home" })) });
    const approved = await createApprovedJob(repository);

    readCdpLaunchState.mockReturnValue({
      profileDir: "/tmp/other-data-root/profiles/someone-else",
      pid: null
    });
    readAllCdpLaunchStates.mockReturnValue([{ profileDir: "/tmp/other-data-root/profiles/someone-else", pid: null }]);

    const response = await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` });

    expect(response.statusCode).toBe(200);
    expect(preparePost).toHaveBeenCalled();
    await expect(repository.getJob(approved.job.id)).resolves.toMatchObject({ status: "posted" });

    await app.close();
  });

  it("posts normally when no launch state is recorded", async () => {
    const repository = await createSqliteRepository(":memory:");
    const preparePost = vi.fn(async () => ({ postUrl: "https://x.com/personal/status/2" }));
    const app = buildApp({
      repository,
      preparePost,
      enableBrowserPost: true,
      checkXLogin: vi.fn(async () => ({ loggedIn: true, handle: "personal-main" }))
    });
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
    const app = buildApp({
      repository,
      preparePost,
      enableBrowserPost: true,
      checkXLogin: vi.fn(async () => ({ loggedIn: true, handle: "personal-main" }))
    });
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

  it("refuses to post when the live login belongs to another account", async () => {
    const repository = await createSqliteRepository(":memory:");
    const account = await repository.getAccount("account_personal");
    const preparePost = vi.fn(async () => ({ postUrl: "https://x.com/personal/status/4" }));
    const app = buildApp({
      repository,
      preparePost,
      enableBrowserPost: true,
      // Right profile, wrong human: the login inside the Chrome does not match.
      checkXLogin: vi.fn(async () => ({ loggedIn: true, handle: "willainotice" }))
    });
    const approved = await createApprovedJob(repository);

    readCdpLaunchState.mockReturnValue({
      profileDir: resolveProfileDir(account!.profileDir),
      pid: null
    });

    const response = await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("Identity mismatch") });
    expect(preparePost).not.toHaveBeenCalled();
    await expect(repository.getJob(approved.job.id)).resolves.toMatchObject({ status: "approved" });

    await app.close();
  });

  it("refuses to post when the logged-in handle cannot be read (fail closed)", async () => {
    const repository = await createSqliteRepository(":memory:");
    const account = await repository.getAccount("account_personal");
    const preparePost = vi.fn(async () => ({ postUrl: "https://x.com/personal/status/5" }));
    const app = buildApp({
      repository,
      preparePost,
      enableBrowserPost: true,
      checkXLogin: vi.fn(async () => ({ loggedIn: true, handle: null }))
    });
    const approved = await createApprovedJob(repository);

    readCdpLaunchState.mockReturnValue({
      profileDir: resolveProfileDir(account!.profileDir),
      pid: null
    });

    const response = await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("Cannot read which X account") });
    expect(preparePost).not.toHaveBeenCalled();

    await app.close();
  });

  it("refuses to post when the posting Chrome is not logged in at all", async () => {
    const repository = await createSqliteRepository(":memory:");
    const account = await repository.getAccount("account_personal");
    const preparePost = vi.fn(async () => ({ postUrl: "https://x.com/personal/status/6" }));
    const app = buildApp({
      repository,
      preparePost,
      enableBrowserPost: true,
      checkXLogin: vi.fn(async () => ({ loggedIn: false, handle: null }))
    });
    const approved = await createApprovedJob(repository);

    readCdpLaunchState.mockReturnValue({
      profileDir: resolveProfileDir(account!.profileDir),
      pid: null
    });

    const response = await app.inject({ method: "POST", url: `/jobs/${approved.job.id}/post` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("not logged in") });
    expect(preparePost).not.toHaveBeenCalled();

    await app.close();
  });
});

describe("autopost score-floor gate", () => {
  it("rejects autopost approval of unedited text that scored below the quality minimum", async () => {
    const repository = await createSqliteRepository(":memory:");
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "score gate idea",
      candidates: [{ text: "weak recap of the source without a point", score: { quality: 4 } }]
    });
    await repository.selectCandidate({ draftId: created.draft.id, candidateId: created.candidates[0]!.id });

    const app = buildApp({ repository });
    const response = await app.inject({
      method: "POST",
      url: `/drafts/${created.draft.id}/approve`,
      payload: { editedText: "weak recap of the source without a point", mode: "autopost" }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("generated_score_below_floor") });
    await app.close();
  });

  it("lets an operator-edited text through even when the generated score was low", async () => {
    const repository = await createSqliteRepository(":memory:");
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "score gate idea two",
      candidates: [{ text: "weak recap of the source without a point", score: { quality: 4 } }]
    });
    await repository.selectCandidate({ draftId: created.draft.id, candidateId: created.candidates[0]!.id });

    const app = buildApp({ repository });
    const response = await app.inject({
      method: "POST",
      url: `/drafts/${created.draft.id}/approve`,
      payload: { editedText: "Operator rewrote this into something with an actual point and payoff.", mode: "autopost" }
    });

    expect(response.statusCode).toBe(201);
    // Attribution memory: features are frozen at approval.
    const draft = await repository.getDraft(created.draft.id);
    expect(draft?.draft.metadata.features).toMatchObject({ words: 11, opener: "operator rewrote this" });
    await app.close();
  });
});
