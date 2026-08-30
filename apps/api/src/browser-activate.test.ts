import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteRepository } from "@zyquor/storage";
import { clearCdpLaunchState, writeCdpLaunchState } from "@zyquor/browser";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { buildApp } from "./app.js";

describe("POST /browser/activate", () => {
  it("returns 404 for an unknown accountId", async () => {
    const app = buildApp({
      repository: await createSqliteRepository(":memory:")
    });

    const response = await app.inject({
      method: "POST",
      url: "/browser/activate",
      payload: { accountId: "does-not-exist" }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "Account not found" });
    await app.close();
  });

  it("activates via the launcher and reports the login state", async () => {
    const launchPostingChrome = vi.fn().mockResolvedValue({ launched: true });
    const checkXLogin = vi.fn().mockResolvedValue({ loggedIn: true, url: null });
    const app = buildApp({
      repository: await createSqliteRepository(":memory:"),
      launchPostingChrome,
      checkXLogin
    });

    const response = await app.inject({
      method: "POST",
      url: "/browser/activate",
      payload: { accountId: "account_personal" }
    });


    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accountId: "account_personal",
      handle: "personal-main",
      active: true,
      loggedIn: true
    });
    // The explicit account id must reach the launcher untouched.
    expect(launchPostingChrome).toHaveBeenCalledWith({ accountId: "account_personal" });
    await app.close();
  });

  it("maps a failed relaunch to 502 with the reason", async () => {
    const launchPostingChrome = vi.fn().mockResolvedValue({ launched: false, reason: "cdp-port-busy" });
    const app = buildApp({
      repository: await createSqliteRepository(":memory:"),
      launchPostingChrome,
      checkXLogin: vi.fn().mockResolvedValue({ loggedIn: false, url: null })
    });

    const response = await app.inject({
      method: "POST",
      url: "/browser/activate",
      payload: { accountId: "account_personal" }
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      error: expect.stringContaining("Could not launch the posting Chrome")
    });
    await app.close();
  });

  it("reports an identity warning when the observed login belongs to another account", async () => {
    const repository = await createSqliteRepository(":memory:");
    await repository.createAccount({
      handle: "willainotice",
      displayName: "Notice AI",
      profileDir: "profiles/willainotice"
    });
    const launchPostingChrome = vi.fn().mockResolvedValue({ launched: true });
    // Operator activated willainotice but the Chrome login is still skywalker's.
    const checkXLogin = vi.fn().mockResolvedValue({ loggedIn: true, handle: "personal-main" });
    const app = buildApp({ repository, launchPostingChrome, checkXLogin });

    const willainotice = (await repository.listAccounts()).find((a) => a.handle === "willainotice");
    const response = await app.inject({
      method: "POST",
      url: "/browser/activate",
      payload: { accountId: willainotice!.id }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      observedHandle: "personal-main",
      warning: expect.stringContaining("logged in as @personal-main")
    });
    await app.close();
  });

  it("reports no identity warning when the observed login matches", async () => {
    const launchPostingChrome = vi.fn().mockResolvedValue({ launched: true });
    const checkXLogin = vi.fn().mockResolvedValue({ loggedIn: true, handle: "personal-main" });
    const app = buildApp({
      repository: await createSqliteRepository(":memory:"),
      launchPostingChrome,
      checkXLogin
    });

    const response = await app.inject({
      method: "POST",
      url: "/browser/activate",
      payload: { accountId: "account_personal" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ observedHandle: "personal-main" });
    expect(response.json().warning).toBeUndefined();
    await app.close();
  });
});

describe("GET /browser/active", () => {
  let testDataRoot: string;

  beforeEach(() => {
    // Sandbox posting-chrome.json writes: readCdpLaunchState resolves against
    // ZYQUOR_DATA_ROOT, so point it at a throwaway directory per test.
    testDataRoot = mkdtempSync(join(tmpdir(), "zyquor-browser-active-test-"));
    process.env.ZYQUOR_DATA_ROOT = testDataRoot;
  });

  afterEach(() => {
    clearCdpLaunchState();
    if (process.env.ZYQUOR_DATA_ROOT === testDataRoot) delete process.env.ZYQUOR_DATA_ROOT;
    rmSync(testDataRoot, { recursive: true, force: true });
  });

  it("reports no active account when there is no launch state", async () => {
    const app = buildApp({ repository: await createSqliteRepository(":memory:") });

    const response = await app.inject({ method: "GET", url: "/browser/active" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accountId: null, handle: null, profileDir: null, activeAccounts: [] });
    await app.close();
  });

  it("resolves the account whose profile the posting Chrome carries", async () => {
    writeCdpLaunchState({ profileDir: join(testDataRoot, "profiles", "personal-main"), pid: 123 });
    const app = buildApp({ repository: await createSqliteRepository(":memory:") });

    const response = await app.inject({ method: "GET", url: "/browser/active" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accountId: "account_personal",
      handle: "personal-main",
      profileDir: join(testDataRoot, "profiles", "personal-main"),
      activeAccounts: expect.arrayContaining([expect.objectContaining({ accountId: "account_personal", handle: "personal-main" })]),
    });
    await app.close();
  });

  it("matches a Windows-style recorded profile from a native posting Chrome", async () => {
    const repository = await createSqliteRepository(":memory:");
    await repository.createAccount({
      handle: "willainotice",
      displayName: "Notice AI",
      profileDir: "profiles/willainotice"
    });
    writeCdpLaunchState({ profileDir: "C:\\Users\\asus\\AppData\\Roaming\\Zyquor\\profiles\\willainotice", pid: 456 });
    const app = buildApp({ repository });

    const response = await app.inject({ method: "GET", url: "/browser/active" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.accountId).toBeTruthy();
    expect(body).toMatchObject({ handle: "willainotice" });
    await app.close();
  });

  it("returns null when the recorded profile matches no account", async () => {
    writeCdpLaunchState({ profileDir: join(testDataRoot, "profiles", "unknown-profile"), pid: null });
    const app = buildApp({ repository: await createSqliteRepository(":memory:") });

    const response = await app.inject({ method: "GET", url: "/browser/active" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accountId: null, handle: null, profileDir: join(testDataRoot, "profiles", "unknown-profile"), activeAccounts: [] });
    await app.close();
  });
});
