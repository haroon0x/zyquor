import { createSqliteRepository, type ZyquorRepository } from "@zyquor/storage";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

async function createPostedHistory(repository: ZyquorRepository, overrides: { postUrl?: string | null } = {}) {
  const created = await repository.createDraft({
    accountId: "account_personal",
    sourceInput: "Delete test idea",
    candidates: [{ text: "Delete test post text", score: {} }]
  });
  return repository.createPostHistory({
    accountId: "account_personal",
    draftId: created.draft.id,
    postedText: "Delete test post text",
    postUrl: overrides.postUrl === undefined ? "https://x.com/personal/status/123" : overrides.postUrl
  });
}

describe("POST /history/:id/delete", () => {
  it("deletes the live tweet and marks the history row deleted", async () => {
    const repository = await createSqliteRepository(":memory:");
    const deletePost = vi.fn(async () => ({ status: "deleted" as const, postUrl: "https://x.com/personal/status/123", alreadyDeleted: false }));
    const app = buildApp({
      repository,
      deletePost,
      enableBrowserPost: true,
      checkXLogin: vi.fn(async () => ({ loggedIn: true, handle: "personal-main" }))
    });
    const history = await createPostedHistory(repository);

    const response = await app.inject({ method: "POST", url: `/history/${history.id}/delete` });

    expect(response.statusCode).toBe(200);
    expect(deletePost).toHaveBeenCalledTimes(1);
    expect(deletePost).toHaveBeenCalledWith(expect.objectContaining({ postUrl: "https://x.com/personal/status/123" }));
    expect(response.json()).toMatchObject({ alreadyDeleted: false });
    const updated = (await repository.listPostHistory()).find((item) => item.id === history.id);
    expect(updated?.metadata).toMatchObject({ deletedVia: "browser", deletedAt: expect.any(String) });

    await app.close();
  });

  it("refuses when browser post actions are disabled", async () => {
    const repository = await createSqliteRepository(":memory:");
    const deletePost = vi.fn(async () => ({ status: "deleted" as const, postUrl: "https://x.com/personal/status/123", alreadyDeleted: false }));
    const app = buildApp({
      repository,
      deletePost,
      checkXLogin: vi.fn(async () => ({ loggedIn: true, handle: "personal-main" }))
    });
    const history = await createPostedHistory(repository);

    const response = await app.inject({ method: "POST", url: `/history/${history.id}/delete` });

    expect(response.statusCode).toBe(403);
    expect(deletePost).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns 404 for an unknown history entry", async () => {
    const repository = await createSqliteRepository(":memory:");
    const app = buildApp({
      repository,
      deletePost: vi.fn(async () => ({ status: "deleted" as const, postUrl: "https://x.com/personal/status/1", alreadyDeleted: false })),
      enableBrowserPost: true,
      checkXLogin: vi.fn(async () => ({ loggedIn: true, handle: "personal-main" }))
    });

    const response = await app.inject({ method: "POST", url: "/history/history_missing/delete" });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it("refuses when the live login belongs to another account", async () => {
    const repository = await createSqliteRepository(":memory:");
    const deletePost = vi.fn(async () => ({ status: "deleted" as const, postUrl: "https://x.com/personal/status/123", alreadyDeleted: false }));
    const app = buildApp({
      repository,
      deletePost,
      enableBrowserPost: true,
      checkXLogin: vi.fn(async () => ({ loggedIn: true, handle: "willainotice" }))
    });
    const history = await createPostedHistory(repository);

    const response = await app.inject({ method: "POST", url: `/history/${history.id}/delete` });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.stringContaining("Identity mismatch") });
    expect(deletePost).not.toHaveBeenCalled();

    await app.close();
  });

  it("is idempotent for an already-deleted history row", async () => {
    const repository = await createSqliteRepository(":memory:");
    const deletePost = vi.fn(async () => ({ status: "deleted" as const, postUrl: "https://x.com/personal/status/123", alreadyDeleted: false }));
    const app = buildApp({
      repository,
      deletePost,
      enableBrowserPost: true,
      checkXLogin: vi.fn(async () => ({ loggedIn: true, handle: "personal-main" }))
    });
    const history = await createPostedHistory(repository);
    await repository.updatePostHistoryMetadata(history.id, { deletedAt: "2026-09-04T00:00:00.000Z", deletedVia: "manual" });

    const response = await app.inject({ method: "POST", url: `/history/${history.id}/delete` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ alreadyDeleted: true });
    expect(deletePost).not.toHaveBeenCalled();

    await app.close();
  });
});
