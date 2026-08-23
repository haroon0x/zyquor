import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dataPath } from "@zyquor/core";
import { findChrome, isCdpUp, launchPostingChrome } from "./chrome.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn((p: unknown) => {
      const known = [
        "/opt/google/chrome/chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/local/bin/google-chrome-stable",
        "/usr/local/bin/google-chrome",
        "/snap/bin/google-chrome-stable",
        "/snap/bin/google-chrome-enterprise",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Users\\testuser\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
      ];
      return known.includes(p as string);
    }),
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    platform: vi.fn(() => "linux"),
  };
});

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const before = process.env[key];
  try {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    fn();
  } finally {
    if (before === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = before;
    }
  }
}

async function withEnvAsync<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[key];
  try {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    return await fn();
  } finally {
    if (before === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = before;
    }
  }
}

let httpServer: Server;
let httpPort: number;
let testDataRoot: string | undefined;

async function startJsonVersionServer(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      if (_req.url === "/json/version") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ "Chrome-Version": "124.0.6367.60" }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr !== "string") {
        httpPort = addr.port;
        httpServer = server;
        resolve(httpPort);
      }
    });
  });
}

beforeAll(async () => {
  // Sandbox state-file writes: without this, dataPath("posting-chrome.json")
  // resolves against process.cwd() and litters the package directory.
  testDataRoot = mkdtempSync(join(tmpdir(), "zyquor-chrome-test-"));
  process.env.ZYQUOR_DATA_ROOT = testDataRoot;
  await startJsonVersionServer();
});

afterEach(() => {
  rmSync(dataPath("posting-chrome.json"), { force: true });
});

afterAll(() => {
  httpServer?.close();
  if (testDataRoot !== undefined) {
    if (process.env.ZYQUOR_DATA_ROOT === testDataRoot) delete process.env.ZYQUOR_DATA_ROOT;
    rmSync(testDataRoot, { recursive: true, force: true });
  }
});

describe("findChrome", () => {
  it("returns path from ZYQUOR_CHROME_PATH if set and exists", () => {
    withEnv("ZYQUOR_CHROME_PATH", "/opt/google/chrome/chrome", () => {
      expect(findChrome()).toBe("/opt/google/chrome/chrome");
    });
  });

  it("returns null when ZYQUOR_CHROME_PATH points to nonexistent file", () => {
    withEnv("ZYQUOR_CHROME_PATH", "/nonexistent/chrome", () => {
      withEnv("CHROME_BIN", undefined, () => {
        expect(findChrome()).toBeNull();
      });
    });
  });

  it("returns first existing linux candidate when env is unset", () => {
    withEnv("ZYQUOR_CHROME_PATH", undefined, () => {
      withEnv("CHROME_BIN", undefined, () => {
        expect(findChrome()).toBe("/usr/bin/google-chrome-stable");
      });
    });
  });

  it("returns null on linux when no candidate exists", () => {
    const mocked = vi.mocked(existsSync);
    mocked.mockImplementation(() => false);
    try {
      withEnv("ZYQUOR_CHROME_PATH", undefined, () => {
        withEnv("CHROME_BIN", undefined, () => {
          expect(findChrome()).toBeNull();
        });
      });
    } finally {
      mocked.mockImplementation((p: unknown) => {
        const known = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/local/bin/google-chrome-stable", "/usr/local/bin/google-chrome", "/snap/bin/google-chrome-stable", "/snap/bin/google-chrome-enterprise"];
        return known.includes(p as string);
      });
    }
  });

  it("uses CHROME_BIN env when set and exists on linux", () => {
    const mocked = vi.mocked(existsSync);
    mocked.mockImplementation((p: unknown) => p === "/custom/chrome");
    try {
      withEnv("ZYQUOR_CHROME_PATH", undefined, () => {
        withEnv("CHROME_BIN", "/custom/chrome", () => {
          expect(findChrome()).toBe("/custom/chrome");
        });
      });
    } finally {
      mocked.mockImplementation((p: unknown) => {
        const known = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/local/bin/google-chrome-stable", "/usr/local/bin/google-chrome", "/snap/bin/google-chrome-stable", "/snap/bin/google-chrome-enterprise"];
        return known.includes(p as string);
      });
    }
  });
});

describe("isCdpUp", () => {
  it("returns true when /json/version responds 200", async () => {
    expect(await isCdpUp(`http://127.0.0.1:${httpPort}`)).toBe(true);
  });

  it("returns false when server is not running", async () => {
    expect(await isCdpUp("http://127.0.0.1:19999")).toBe(false);
  });
});

describe("launchPostingChrome", () => {
  it("returns already-running when CDP is up for the same profile", async () => {
    // The launcher trusts a running posting Chrome only when the shared state
    // file records it as carrying the requested account profile.
    const profileDir = "/tmp/zyquor-data-root/profiles/personal-main";
    writeFileSync(dataPath("posting-chrome.json"), JSON.stringify({ profileDir, pid: null }));
    const result = await launchPostingChrome({ profileDir, cdpPort: httpPort });
    expect(result).toEqual({ launched: false, reason: "already-running" });
  });

  it("refuses to reuse a running Chrome launched for a different profile", { timeout: 10_000 }, async () => {
    const requested = "/tmp/zyquor-data-root/profiles/willainotice";
    // State records a different account: the launcher must not trust the
    // running browser. With no Chrome binary findable and the mock CDP server
    // never going down, it fails closed with cdp-port-busy instead of
    // reusing the wrong account.
    writeFileSync(dataPath("posting-chrome.json"), JSON.stringify({ profileDir: "/tmp/zyquor-data-root/profiles/personal-main", pid: null }));
    const mocked = vi.mocked(existsSync);
    mocked.mockImplementation(() => false);
    try {
      const result = await withEnvAsync("ZYQUOR_CHROME_PATH", undefined, () =>
        withEnvAsync("CHROME_BIN", undefined, () => launchPostingChrome({ profileDir: requested, cdpPort: httpPort })));
      expect(result).toEqual({ launched: false, reason: "cdp-port-busy" });
    } finally {
      mocked.mockImplementation((p: unknown) => {
        const known = [
          "/opt/google/chrome/chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/google-chrome",
          "/usr/local/bin/google-chrome-stable",
          "/usr/local/bin/google-chrome",
          "/snap/bin/google-chrome-stable",
          "/snap/bin/google-chrome-enterprise",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Users\\testuser\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
        ];
        return known.includes(p as string);
      });
    }
  });

  it("returns chrome-not-found when CDP is down and no chrome exists", async () => {
    const mocked = vi.mocked(existsSync);
    mocked.mockImplementation(() => false);
    try {
      const result = await withEnvAsync("ZYQUOR_CHROME_PATH", undefined, () =>
        withEnvAsync("CHROME_BIN", undefined, () =>
          launchPostingChrome({
            profileDir: "/tmp/zyquor-data-root/profiles/personal-main",
            cdpPort: 19999,
          })));
      expect(result).toEqual({ launched: false, reason: "chrome-not-found" });
    } finally {
      mocked.mockImplementation((p: unknown) => {
        const known = ["/usr/bin/google-chrome-stable", "/usr/bin/google-chrome", "/usr/local/bin/google-chrome-stable", "/usr/local/bin/google-chrome", "/snap/bin/google-chrome-stable", "/snap/bin/google-chrome-enterprise"];
        return known.includes(p as string);
      });
    }
  }, 10000);
});
