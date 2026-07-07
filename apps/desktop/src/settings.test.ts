import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySettingsToEnv, loadSettings, saveSettings, type DesktopSettings } from "./settings.js";

const tmpRoot = "/tmp/zyquor-desktop-settings-test";
const dataRoot = join(tmpRoot, "userData");

function ensureClean() {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(dataRoot, { recursive: true });
}

beforeEach(() => {
  ensureClean();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadSettings", () => {
  it("returns empty object when settings.json is missing", () => {
    expect(loadSettings(dataRoot)).toEqual({});
  });

  it("returns empty object on invalid JSON (warn, no crash)", () => {
    writeFileSync(join(dataRoot, "settings.json"), "not json", "utf8");
    expect(loadSettings(dataRoot)).toEqual({});
  });

  it("returns empty object when file is a JSON array", () => {
    writeFileSync(join(dataRoot, "settings.json"), "[1,2,3]", "utf8");
    expect(loadSettings(dataRoot)).toEqual({});
  });

  it("loads valid settings", () => {
    const settings: DesktopSettings = {
      enableBrowserPrepare: true,
      llmProvider: "openrouter",
      cdpPort: 9222,
    };
    writeFileSync(join(dataRoot, "settings.json"), JSON.stringify(settings), "utf8");
    expect(loadSettings(dataRoot)).toEqual(settings);
  });
});

describe("saveSettings", () => {
  it("saves and round-trips settings", () => {
    const settings: DesktopSettings = {
      enableBrowserPost: true,
      openrouterApiKey: "sk-or-v1-secret",
      chromePath: "/usr/bin/chrome",
    };
    saveSettings(dataRoot, settings);
    const loaded = loadSettings(dataRoot);
    expect(loaded).toEqual(settings);
  });

  it("atomic write leaves valid file after crash", () => {
    const good: DesktopSettings = { llmProvider: "gemini" };
    // Write a partial .tmp file to simulate a crash mid-write
    writeFileSync(join(dataRoot, "settings.json.tmp"), '{ "llmProv', "utf8");
    // Now write the real file - the tmp gets atomically renamed
    saveSettings(dataRoot, good);
    expect(loadSettings(dataRoot)).toEqual(good);
  });

  it("overwrites existing file", () => {
    saveSettings(dataRoot, { cdpPort: 9222 });
    saveSettings(dataRoot, { cdpPort: 9223 });
    expect(loadSettings(dataRoot)).toEqual({ cdpPort: 9223 });
  });
});

describe("applySettingsToEnv", () => {
  function withCleanEnv(fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    const keys = [
      "ZYQUOR_ENABLE_BROWSER_PREPARE",
      "ZYQUOR_ENABLE_BROWSER_POST",
      "ZYQUOR_LLM_PROVIDER",
      "ZYQUOR_OPENROUTER_API_KEY",
      "ZYQUOR_GEMINI_API_KEY",
      "ZYQUOR_CHROME_PATH",
      "ZYQUOR_BROWSER_CDP_PORT",
    ];
    for (const key of keys) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      fn();
    } finally {
      for (const key of keys) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    }
  }

  it("sets env vars from settings when not already present", () => {
    withCleanEnv(() => {
      applySettingsToEnv({
        enableBrowserPrepare: true,
        llmProvider: "openrouter",
        openrouterApiKey: "sk-test",
        cdpPort: 9222,
      });
      expect(process.env.ZYQUOR_ENABLE_BROWSER_PREPARE).toBe("1");
      expect(process.env.ZYQUOR_LLM_PROVIDER).toBe("openrouter");
      expect(process.env.ZYQUOR_OPENROUTER_API_KEY).toBe("sk-test");
      expect(process.env.ZYQUOR_BROWSER_CDP_PORT).toBe("9222");
    });
  });

  it("does not override pre-existing env vars (shell precedence)", () => {
    withCleanEnv(() => {
      process.env.ZYQUOR_LLM_PROVIDER = "gemini";
      applySettingsToEnv({ llmProvider: "openrouter" });
      expect(process.env.ZYQUOR_LLM_PROVIDER).toBe("gemini");
    });
  });

  it("does not set boolean env var when settings field is undefined", () => {
    withCleanEnv(() => {
      applySettingsToEnv({});
      expect(process.env.ZYQUOR_ENABLE_BROWSER_PREPARE).toBeUndefined();
    });
  });

  it("sets boolean env to 0 when false", () => {
    withCleanEnv(() => {
      applySettingsToEnv({ enableBrowserPrepare: false });
      expect(process.env.ZYQUOR_ENABLE_BROWSER_PREPARE).toBe("0");
    });
  });
});
