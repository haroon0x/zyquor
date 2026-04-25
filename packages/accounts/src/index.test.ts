import { describe, expect, it } from "vitest";
import { assertDedicatedProfileDir } from "./index.js";

describe("profile directory guard", () => {
  it("allows dedicated project profiles", () => {
    expect(() => assertDedicatedProfileDir("profiles/personal-main")).not.toThrow();
  });

  it("rejects everyday browser profiles", () => {
    expect(() => assertDedicatedProfileDir("/home/g/.config/google-chrome/Default")).toThrow();
  });
});
