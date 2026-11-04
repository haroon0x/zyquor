import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connectOverCDP } = vi.hoisted(() => ({
  connectOverCDP: vi.fn()
}));

vi.mock("playwright-core", () => ({
  chromium: { connectOverCDP }
}));

import { closeBrowserCdp, ensureBrowserCdp, readCdpLaunchState, writeCdpLaunchState } from "./index.js";

const cdpUrl = "http://127.0.0.1:9225";

let testDataRoot: string;

beforeEach(async () => {
  testDataRoot = mkdtempSync(join(tmpdir(), "zyquor-ensure-cdp-test-"));
  process.env.ZYQUOR_DATA_ROOT = testDataRoot;
  // Reset both the in-memory attachment cache and the on-disk launch state
  // between tests via the module's own close path.
  connectOverCDP.mockResolvedValue(null);
  await closeBrowserCdp(cdpUrl);
  rmSync(join(testDataRoot, "posting-chrome.json"), { force: true });
});

afterEach(() => {
  if (process.env.ZYQUOR_DATA_ROOT === testDataRoot) delete process.env.ZYQUOR_DATA_ROOT;
  rmSync(testDataRoot, { recursive: true, force: true });
});

describe("ensureBrowserCdp per-profile concurrency", () => {
  it("allows attaching when no launch state is recorded", async () => {
    connectOverCDP.mockResolvedValue({});
    expect(existsSync(join(testDataRoot, "posting-chrome.json"))).toBe(false);

    const result = await ensureBrowserCdp(cdpUrl, "/tmp/root-a/profiles/personal-main");

    expect(result).toBe(true);
  });

  it("allows attaching when the recorded state matches the requested profile", async () => {
    connectOverCDP.mockResolvedValue({});
    writeCdpLaunchState({ profileDir: "/tmp/root-a/profiles/personal-main", pid: null });

    const result = await ensureBrowserCdp(cdpUrl, "/tmp/root-a/profiles/personal-main");

    expect(result).toBe(true);
  });

  it("normalizes a Windows-style recorded path to the current data root", async () => {
    connectOverCDP.mockResolvedValue({});
    writeCdpLaunchState({ profileDir: "C:\\Users\\example\\AppData\\Roaming\\Zyquor\\profiles\\personal-main", pid: 23772 });

    expect(readCdpLaunchState()?.profileDir).toBe(join(testDataRoot, "profiles", "personal-main"));

    const result = await ensureBrowserCdp(cdpUrl, join(testDataRoot, "profiles", "personal-main"));
    expect(result).toBe(true);
  });

  it("allows attaching when a different profile is already recorded on another port", async () => {
    connectOverCDP.mockResolvedValue({});
    writeCdpLaunchState({ profileDir: "/tmp/root-a/profiles/someone-else", pid: null });
    expect(readCdpLaunchState()?.profileDir).toBe("/tmp/root-a/profiles/someone-else");

    const otherCdpUrl = "http://127.0.0.1:9226";
    connectOverCDP.mockResolvedValue({});
    const result = await ensureBrowserCdp(otherCdpUrl, "/tmp/root-a/profiles/personal-main");
    expect(result).toBe(true);
  });
});
