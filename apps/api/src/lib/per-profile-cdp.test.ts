import { describe, expect, it } from "vitest";
import { perProfileCdpUrl as fromCore } from "@zyquor/core";
import { perProfileCdpUrl } from "./per-profile-cdp.js";

// The implementation lives in @zyquor/core because the desktop launcher needs
// it too. This guard fails if the API ever drifts back to a local copy.
describe("perProfileCdpUrl re-export", () => {
  it("is the same function the core package exports", () => {
    expect(perProfileCdpUrl).toBe(fromCore);
  });
});
