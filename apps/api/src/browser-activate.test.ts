import { createSqliteRepository } from "@zyquor/storage";
import { describe, expect, it, vi } from "vitest";
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
});
