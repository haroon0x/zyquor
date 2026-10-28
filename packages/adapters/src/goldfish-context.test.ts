import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearGoldfishContextCache, deriveGoldfishTerms, fetchGoldfishReplyContext, renderGoldfishMemory } from "./goldfish-context.js";

const { callGoldfishTool } = vi.hoisted(() => ({ callGoldfishTool: vi.fn() }));

vi.mock("./goldfish.js", () => ({
  callGoldfishTool
}));

const wikiHit = {
  slug: "acme-labs",
  title: "Acme Labs",
  type: "company",
  summary: "Acme Labs builds developer tooling." + " More details follow. ".repeat(20)
};

const memoryHit = {
  app: "vscode",
  captured_at: "2026-10-20T09:15:00.000Z",
  window_title: "acme-labs refactor",
  content_excerpt: "Migrated the worker to per-account locks.".repeat(4)
};

beforeEach(() => {
  callGoldfishTool.mockReset();
  clearGoldfishContextCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("deriveGoldfishTerms", () => {
  it("puts the handle first, adds the display name, then text keywords", () => {
    const terms = deriveGoldfishTerms({
      authorHandle: "@engineer_jane",
      authorName: "Jane Doe",
      tweetText: "Shipping the renderer pipeline; latencies matter here"
    });
    expect(terms).toEqual(["engineer_jane", "Jane Doe", "shipping", "renderer", "pipeline", "latencies"]);
  });

  it("caps keywords at four and the whole list at six", () => {
    const text = "alpha bravo charlie delta echo foxtrot golf hotel";
    const withoutIdentity = deriveGoldfishTerms({ tweetText: text });
    expect(withoutIdentity).toEqual(["alpha", "bravo", "charlie", "delta"]);

    const withIdentity = deriveGoldfishTerms({ authorHandle: "bob", authorName: "Bob Smith", tweetText: text });
    expect(withIdentity).toEqual(["bob", "Bob Smith", "alpha", "bravo", "charlie", "delta"]);
  });

  it("drops short tokens, numbers, stopwords, and dedupes case-insensitively", () => {
    const terms = deriveGoldfishTerms({
      authorHandle: "Bob",
      authorName: "BOB",
      tweetText: "Bob 2026 here trying API-based tooling that already worked 2000"
    });
    expect(terms).toEqual(["Bob", "trying", "based", "tooling", "already"]);
  });
});

describe("renderGoldfishMemory", () => {
  it("returns an empty string when there is nothing to show", () => {
    expect(renderGoldfishMemory({ terms: [], wiki: [], memories: [] })).toBe("");
  });

  it("renders wiki and memory entries and caps the block at 1600 characters", () => {
    const rendered = renderGoldfishMemory({
      terms: ["acme"],
      wiki: [{ slug: "acme-labs", title: "Acme Labs", type: "company", summary: "s".repeat(700) }],
      memories: [{ app: "vscode", capturedAt: "2026-10-20", title: "refactor", excerpt: "y".repeat(900) }]
    });
    expect(rendered.startsWith("Personal memory from the account owner's own machine:")).toBe(true);
    expect(rendered).toContain("Wiki [company] Acme Labs");
    expect(rendered.length).toBeLessThanOrEqual(1600);
  });

  it("drops entries that would push the block past the cap", () => {
    const rendered = renderGoldfishMemory({
      terms: [],
      wiki: [{ slug: "huge", title: "Huge", type: "topic", summary: "s".repeat(1700) }],
      memories: []
    });
    expect(rendered).not.toContain("Huge");
    expect(rendered).toBe("Personal memory from the account owner's own machine:");
  });

  it("keeps everything when the bundle is small", () => {
    const rendered = renderGoldfishMemory({
      terms: ["acme"],
      wiki: [{ slug: "acme-labs", title: "Acme Labs", type: "company", summary: "Developer tooling." }],
      memories: [{ app: "vscode", capturedAt: "2026-10-20", title: "refactor", excerpt: "Moved to per-account locks." }]
    });
    expect(rendered).toContain("Wiki [company] Acme Labs: Developer tooling.");
    expect(rendered).toContain("- Activity (vscode, 2026-10-20): refactor: Moved to per-account locks.");
  });
});

describe("fetchGoldfishReplyContext", () => {
  function goldfishHits() {
    callGoldfishTool.mockImplementation((tool: string) => {
      if (tool === "search_wiki") return Promise.resolve({ results: [wikiHit] });
      if (tool === "search_memory") return Promise.resolve([memoryHit]);
      return Promise.reject(new Error(`unexpected tool ${tool}`));
    });
  }

  it("calls search_wiki with the author name and search_memory with derived terms", async () => {
    goldfishHits();
    const bundle = await fetchGoldfishReplyContext({
      authorHandle: "engineer_jane",
      authorName: "Jane Doe",
      tweetText: "Shipping the renderer pipeline; latencies matter here"
    });

    expect(bundle).not.toBeNull();
    expect(callGoldfishTool).toHaveBeenCalledWith("search_wiki", { query: "Jane Doe", limit: 4 });
    expect(callGoldfishTool).toHaveBeenCalledWith(
      "search_memory",
      { query: "engineer_jane Jane Doe shipping renderer pipeline latencies", limit: 5 }
    );
    expect(bundle?.terms).toEqual(["engineer_jane", "Jane Doe", "shipping", "renderer", "pipeline", "latencies"]);
    expect(bundle?.wiki[0]?.title).toBe("Acme Labs");
    expect(bundle?.memories[0]?.capturedAt).toBe("2026-10-20T09:15:00.000Z");
  });

  it("respects maxWiki and maxMemories caps and trims long text", async () => {
    goldfishHits();
    const bundle = await fetchGoldfishReplyContext({
      authorHandle: "acme",
      maxWiki: 1,
      maxMemories: 1
    });
    expect(bundle?.terms).toEqual(["acme"]);
    expect(bundle?.wiki).toHaveLength(1);
    expect(bundle?.memories).toHaveLength(1);
    expect(bundle?.wiki[0]?.summary.length).toBeLessThanOrEqual(300);
    expect(bundle?.memories[0]?.excerpt.length).toBeLessThanOrEqual(280);
  });

  it("caches bundles for ten minutes and clears with clearGoldfishContextCache", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-26T12:00:00.000Z") });
    goldfishHits();

    await fetchGoldfishReplyContext({ authorHandle: "acme" });
    vi.advanceTimersByTime(9 * 60 * 1000);
    await fetchGoldfishReplyContext({ authorHandle: "acme" });
    expect(callGoldfishTool).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(3 * 60 * 1000);
    await fetchGoldfishReplyContext({ authorHandle: "acme" });
    expect(callGoldfishTool).toHaveBeenCalledTimes(4);

    clearGoldfishContextCache();
    await fetchGoldfishReplyContext({ authorHandle: "acme" });
    expect(callGoldfishTool).toHaveBeenCalledTimes(6);
  });

  it("caches misses for one minute only", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-26T12:00:00.000Z") });
    callGoldfishTool.mockRejectedValue(new Error("goldfish down"));

    const first = await fetchGoldfishReplyContext({ authorHandle: "acme" });
    const second = await fetchGoldfishReplyContext({ authorHandle: "acme" });
    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(callGoldfishTool).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(61 * 1000);
    await fetchGoldfishReplyContext({ authorHandle: "acme" });
    expect(callGoldfishTool).toHaveBeenCalledTimes(4);
  });

  it("does not cache across different lookup keys", async () => {
    goldfishHits();
    await fetchGoldfishReplyContext({ authorHandle: "acme" });
    await fetchGoldfishReplyContext({ authorHandle: "other" });
    expect(callGoldfishTool).toHaveBeenCalledTimes(4);
  });
});

