import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { resolveDataRoot, dataPath, profilesPath, perProfileCdpUrl } from "./paths.js";

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

describe("resolveDataRoot", () => {
  it("returns process.cwd() when neither env var is set", () => {
    withEnv("ZYQUOR_DATA_ROOT", undefined, () => {
      withEnv("ZYQUOR_WORKSPACE_ROOT", undefined, () => {
        expect(resolveDataRoot()).toBe(process.cwd());
      });
    });
  });

  it("returns the resolved absolute path when ZYQUOR_DATA_ROOT is set", () => {
    withEnv("ZYQUOR_DATA_ROOT", "/tmp/zyq-test", () => {
      withEnv("ZYQUOR_WORKSPACE_ROOT", undefined, () => {
        expect(resolveDataRoot()).toBe(resolve("/tmp/zyq-test"));
      });
    });
  });

  it("falls back to ZYQUOR_WORKSPACE_ROOT when ZYQUOR_DATA_ROOT is unset", () => {
    withEnv("ZYQUOR_DATA_ROOT", undefined, () => {
      withEnv("ZYQUOR_WORKSPACE_ROOT", "/tmp/zyq-workspace", () => {
        expect(resolveDataRoot()).toBe(resolve("/tmp/zyq-workspace"));
      });
    });
  });

  it("resolves relative paths against cwd", () => {
    withEnv("ZYQUOR_DATA_ROOT", "./test-data", () => {
      withEnv("ZYQUOR_WORKSPACE_ROOT", undefined, () => {
        expect(resolveDataRoot()).toBe(resolve(process.cwd(), "test-data"));
      });
    });
  });
});

describe("dataPath", () => {
  it("joins segments under the data root", () => {
    withEnv("ZYQUOR_DATA_ROOT", "/tmp/zyq-test", () => {
      expect(dataPath("data", "app.json")).toBe(resolve("/tmp/zyq-test", "data", "app.json"));
    });
  });

  it("uses process.cwd() when no env is set", () => {
    withEnv("ZYQUOR_DATA_ROOT", undefined, () => {
      withEnv("ZYQUOR_WORKSPACE_ROOT", undefined, () => {
        expect(dataPath("data", "app.json")).toBe(resolve(process.cwd(), "data", "app.json"));
      });
    });
  });
});

describe("profilesPath", () => {
  it("joins segments under profiles/ in the data root", () => {
    withEnv("ZYQUOR_DATA_ROOT", "/tmp/zyq-test", () => {
      expect(profilesPath("personal-main")).toBe(resolve("/tmp/zyq-test", "profiles", "personal-main"));
    });
  });

  it("returns the profiles directory when called with no segments", () => {
    withEnv("ZYQUOR_DATA_ROOT", "/tmp/zyq-test", () => {
      expect(profilesPath()).toBe(resolve("/tmp/zyq-test", "profiles"));
    });
  });
});

describe("perProfileCdpUrl", () => {
  const base = "http://127.0.0.1:9223";

  afterEach(() => {
    delete process.env.ZYQUOR_BROWSER_CDP_BASE_PROFILES;
  });

  it("keeps the default personal-main profile on the base port", () => {
    expect(perProfileCdpUrl(base, "profiles/personal-main")).toBe(base);
  });

  it("gives each unlisted profile a stable, distinct port", () => {
    const first = perProfileCdpUrl(base, "profiles/another-account");
    const second = perProfileCdpUrl(base, "profiles/another-account");
    const other = perProfileCdpUrl(base, "profiles/third-account");
    expect(first).toBe(second);
    expect(new URL(first).port).toBe("9225");
    expect(other).not.toBe(first);
  });

  it("honours the configured base-port profile list", () => {
    process.env.ZYQUOR_BROWSER_CDP_BASE_PROFILES = "personal-main,reply-loop-test";
    expect(perProfileCdpUrl(base, "profiles/reply-loop-test")).toBe(base);
  });

  it("matches profile names case-insensitively through Windows paths", () => {
    process.env.ZYQUOR_BROWSER_CDP_BASE_PROFILES = "reply-loop-test";
    expect(perProfileCdpUrl(base, "C:\\Users\\example\\zyquor-profiles\\Reply-Loop-Test")).toBe(base);
  });

  it("falls back to the base URL when the input is unparseable", () => {
    expect(perProfileCdpUrl("not a url", "profiles/x")).toBe("not a url");
  });
});
