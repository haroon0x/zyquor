import { describe, expect, it } from "vitest";
import { canTransitionDraft, canTransitionPostJob } from "./state.js";

describe("state transitions", () => {
  it("allows draft approval from created or selected", () => {
    expect(canTransitionDraft("selected", "approved")).toBe(true);
    expect(canTransitionDraft("created", "approved")).toBe(true);
  });

  it("keeps posted and cancelled jobs terminal", () => {
    expect(canTransitionPostJob("posted", "failed")).toBe(false);
    expect(canTransitionPostJob("cancelled", "queued")).toBe(false);
  });

  it("allows failed jobs to be explicitly requeued", () => {
    expect(canTransitionPostJob("failed", "queued")).toBe(true);
  });
});
