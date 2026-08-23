import { createSqliteRepository } from "@zyquor/storage";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";

describe("POST /browser/launch-chrome", () => {
  it("returns 404 when launchPostingChrome dep is not provided", async () => {
    const app = buildApp({
      repository: await createSqliteRepository(":memory:"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/browser/launch-chrome",
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns 200 and calls the stub when launchPostingChrome dep is provided", async () => {
    const stub = vi.fn().mockResolvedValue({ launched: true });
    const app = buildApp({
      launchPostingChrome: stub,
      repository: await createSqliteRepository(":memory:"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/browser/launch-chrome",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ launched: true });
    expect(stub).toHaveBeenCalledWith({ accountId: "account_personal" });
    await app.close();
  });

  it("passes custom accountId to the dep", async () => {
    const stub = vi.fn().mockResolvedValue({ launched: false, reason: "chrome-not-found" });
    const app = buildApp({
      launchPostingChrome: stub,
      repository: await createSqliteRepository(":memory:"),
    });

    const response = await app.inject({
      method: "POST",
      url: "/browser/launch-chrome",
      payload: { accountId: "account_alt" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ launched: false, reason: "chrome-not-found" });
    expect(stub).toHaveBeenCalledWith({ accountId: "account_alt" });
    await app.close();
  });
});
