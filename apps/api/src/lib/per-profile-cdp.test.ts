import { afterEach, describe, expect, it } from "vitest";
import { perProfileCdpUrl } from "./per-profile-cdp.js";

const base = "http://172.31.96.1:9223";

describe("perProfileCdpUrl", () => {
  afterEach(() => {
    delete process.env.ZYQUOR_BROWSER_CDP_BASE_PROFILES;
  });

  it("keeps the default personal-main profile on the base port", () => {
    expect(perProfileCdpUrl(base, "profiles/personal-main")).toBe(base);
  });

  it("puts an unlisted profile on a stable hashed offset", () => {
    const first = perProfileCdpUrl(base, "profiles/another-account");
    const second = perProfileCdpUrl(base, "profiles/another-account");
    expect(first).toBe(second);
    expect(new URL(first).port).toBe("9225");
  });

  it("honours the configured base-port profile list", () => {
    process.env.ZYQUOR_BROWSER_CDP_BASE_PROFILES = "personal-main,reply-loop-test";
    expect(perProfileCdpUrl(base, "profiles/reply-loop-test")).toBe(base);
  });

  it("matches the profile name case-insensitively and through Windows paths", () => {
    process.env.ZYQUOR_BROWSER_CDP_BASE_PROFILES = "reply-loop-test";
    expect(perProfileCdpUrl(base, "C:\\Users\\asus\\zyquor-profiles\\Reply-Loop-Test")).toBe(base);
  });
});
