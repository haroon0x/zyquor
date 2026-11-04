import { createSqliteRepository } from "@zyquor/storage";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { DesktopSettingsData } from "./deps.js";

function mockDesktopSettings(initial: DesktopSettingsData = {}) {
  let state = { ...initial };
  return {
    get: vi.fn(() => ({ ...state })),
    update: vi.fn((patch: DesktopSettingsData) => {
      for (const key of Object.keys(patch) as (keyof DesktopSettingsData)[]) {
        if (patch[key] === "") {
          delete state[key];
        } else if (patch[key] !== undefined) {
          (state as Record<string, unknown>)[key] = patch[key];
        }
      }
      return { ...state };
    }),
  };
}

describe("/settings routes", () => {
  it("returns 404 when desktopSettings dep is not provided", async () => {
    const app = buildApp({
      repository: await createSqliteRepository(":memory:"),
    });
    const getRes = await app.inject({ method: "GET", url: "/settings" });
    expect(getRes.statusCode).toBe(404);

    const patchRes = await app.inject({
      method: "PATCH",
      url: "/settings",
      payload: { llmProvider: "gemini" },
    });
    expect(patchRes.statusCode).toBe(404);
    await app.close();
  });

  it("GET returns masked settings", async () => {
    const dep = mockDesktopSettings({
      enableBrowserPrepare: true,
      geminiApiKey: "AIza1234567890abcdef",
      cdpPort: 9222,
    });
    const app = buildApp({
      desktopSettings: dep,
      repository: await createSqliteRepository(":memory:"),
    });
    const res = await app.inject({ method: "GET", url: "/settings" });
    expect(res.statusCode).toBe(200);
    const body = res.json<DesktopSettingsData>();
    expect(body.enableBrowserPrepare).toBe(true);
    expect(body.cdpPort).toBe(9222);
    expect(body.geminiApiKey).toBe("****************cdef");
    await app.close();
  });

  it("PATCH updates settings and returns masked result", async () => {
    const dep = mockDesktopSettings({ llmProvider: "gemini" });
    const app = buildApp({
      desktopSettings: dep,
      repository: await createSqliteRepository(":memory:"),
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/settings",
      payload: {
        enableBrowserPost: true,
        geminiApiKey: "sk-or-v1-newkey1234",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<DesktopSettingsData & { restartRequired?: boolean }>();
    expect(body.enableBrowserPost).toBe(true);
    expect(body.geminiApiKey).toBe("***************1234");
    expect(body.restartRequired).toBe(false);
    expect(dep.update).toHaveBeenCalledWith({
      enableBrowserPost: true,
      geminiApiKey: "sk-or-v1-newkey1234",
    });
    await app.close();
  });

  it("PATCH ignores a masked API key", async () => {
    const geminiApiKey = "sk-or-v1-1234567890abcdef";
    const dep = mockDesktopSettings({ geminiApiKey });
    const app = buildApp({
      desktopSettings: dep,
      repository: await createSqliteRepository(":memory:"),
    });
    const masked = "*********************cdef";
    const res = await app.inject({
      method: "PATCH",
      url: "/settings",
      payload: { geminiApiKey: masked },
    });
    expect(res.statusCode).toBe(200);
    expect(dep.update).toHaveBeenCalledWith({});
    expect(dep.get().geminiApiKey).toBe(geminiApiKey);
    expect(res.json().restartRequired).toBe(false);
    await app.close();
  });

  it("empty-string value deletes a key", async () => {
    const dep = mockDesktopSettings({ chromePath: "/usr/bin/chrome", cdpPort: 9222 });
    const app = buildApp({
      desktopSettings: dep,
      repository: await createSqliteRepository(":memory:"),
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/settings",
      payload: { chromePath: "" },
    });
    expect(res.statusCode).toBe(200);
    // The update fn should receive the args after delete (the route deletes empty before calling update)
    expect(dep.update).toHaveBeenCalledWith({});
    await app.close();
  });

  it("no restartRequired when only non-sensitive keys change", async () => {
    const dep = mockDesktopSettings({});
    const app = buildApp({
      desktopSettings: dep,
      repository: await createSqliteRepository(":memory:"),
    });
    const res = await app.inject({
      method: "PATCH",
      url: "/settings",
      payload: { chromePath: "/opt/chrome", cdpPort: 9223 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ restartRequired?: boolean }>();
    expect(body.restartRequired).toBeFalsy();
    await app.close();
  });

  it("masks short API keys entirely", async () => {
    const dep = mockDesktopSettings({ geminiApiKey: "xyz" });
    const app = buildApp({
      desktopSettings: dep,
      repository: await createSqliteRepository(":memory:"),
    });
    const res = await app.inject({ method: "GET", url: "/settings" });
    expect(res.statusCode).toBe(200);
    const body = res.json<DesktopSettingsData>();
    expect(body.geminiApiKey).toBe("****");
    await app.close();
  });
});
