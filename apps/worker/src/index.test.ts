import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkWorkerStartup,
  createWorkerState,
  processApprovedJobs,
  processIngest,
  processNewSourcePackets,
  recoverStaleJobs,
  runWorkerCycle,
  startWorker,
  type WorkerHandle
} from "./index.js";

const baseJob = {
  accountId: "account_personal",
  approvedAt: "2026-04-25T10:00:00.000Z",
  createdAt: "2026-04-25T10:00:00.000Z",
  draftId: "draft_1",
  mode: "prepare_only",
  scheduledFor: null,
  status: "approved",
  updatedAt: "2026-04-25T10:00:00.000Z"
};

const baseAccount = {
  id: "account_personal",
  handle: "personal-main",
  displayName: "Personal main",
  profileDir: "profiles/personal-main",
  styleProfileId: "style_default",
  postingMode: "prepare_only",
  enabled: true,
  dailyPostLimit: 5,
  quietHoursStart: null,
  quietHoursEnd: null,
  createdAt: "2026-04-25T10:00:00.000Z",
  updatedAt: "2026-04-25T10:00:00.000Z"
};

describe("worker job processing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("prepares due scheduled jobs and skips future/manual jobs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/health")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/jobs")) {
          return Response.json({
            jobs: [
              { ...baseJob, id: "job_due", mode: "scheduled", scheduledFor: "2026-04-25T11:00:00.000Z" },
              { ...baseJob, id: "job_future", mode: "scheduled", scheduledFor: "2026-04-25T13:00:00.000Z" },
              { ...baseJob, id: "job_manual", mode: "review_required" }
            ]
          });
        }
        if (url.endsWith("/accounts")) {
          return Response.json({
            accounts: [baseAccount]
          });
        }
        if (url.includes("/browser/x-session")) {
          return Response.json({ loggedIn: true });
        }
        return Response.json({ ok: true });
      })
    );

    const processed = await processApprovedJobs({ apiUrl: "http://api.test", pollMs: 1000 });

    expect(processed).toBe(1);
    expect(calls).toContain("POST http://api.test/jobs/job_due/prepare");
    expect(calls).not.toContain("POST http://api.test/jobs/job_future/prepare");
    expect(calls).not.toContain("POST http://api.test/jobs/job_manual/prepare");
  });

  it("posts due autopost jobs through the explicit post endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/health")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/jobs")) {
          return Response.json({
            jobs: [{ ...baseJob, id: "job_auto", mode: "autopost", scheduledFor: "2026-04-25T11:00:00.000Z" }]
          });
        }
        if (url.endsWith("/accounts")) {
          return Response.json({
            accounts: [baseAccount]
          });
        }
        if (url.includes("/browser/x-session")) {
          return Response.json({ loggedIn: true });
        }
        return Response.json({ ok: true });
      })
    );

    const processed = await processApprovedJobs({ apiUrl: "http://api.test", pollMs: 1000 });

    expect(processed).toBe(1);
    expect(calls).toContain("POST http://api.test/jobs/job_auto/post");
  });

  it("queues async ingest without blocking the worker cycle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/drafts/pending")) {
          return Response.json({ drafts: [] });
        }
        if (url.endsWith("/jobs/recover-stale")) {
          return Response.json({ recoveredCount: 0, recovered: [] });
        }
        if (url.endsWith("/ingest-run/async")) {
          return Response.json({ accepted: true, ingestRun: { processed: 0, running: true } }, { status: 202 });
        }
        if (url.endsWith("/health")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/jobs")) {
          return Response.json({ jobs: [] });
        }
        if (url.endsWith("/accounts")) {
          return Response.json({
            accounts: [baseAccount]
          });
        }
        if (url.includes("/browser/x-session")) {
          return Response.json({ loggedIn: true });
        }
        return Response.json({ ok: true });
      })
    );

    const result = await runWorkerCycle(
      { apiUrl: "http://api.test", pollMs: 1000, ingestIntervalMs: 60_000 },
      createWorkerState()
    );

    expect(result.approvedProcessed).toBe(0);
    expect(calls).toContain("POST http://api.test/ingest-run/async");
  });

  it("submits each autopost job only once even if the API repeats an approved job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/drafts/pending")) {
          return Response.json({ drafts: [] });
        }
        if (url.endsWith("/jobs/recover-stale")) {
          return Response.json({ recoveredCount: 0, recovered: [] });
        }
        if (url.endsWith("/ingest-run/async")) {
          return Response.json({ accepted: false, ingestRun: { processed: 0, running: true } }, { status: 202 });
        }
        if (url.endsWith("/health")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/jobs")) {
          return Response.json({
            jobs: [
              { ...baseJob, id: "job_auto", mode: "autopost", scheduledFor: "2026-04-25T11:00:00.000Z" },
              { ...baseJob, id: "job_auto", mode: "autopost", scheduledFor: "2026-04-25T11:00:00.000Z" }
            ]
          });
        }
        if (url.endsWith("/accounts")) {
          return Response.json({
            accounts: [baseAccount]
          });
        }
        if (url.includes("/browser/x-session")) {
          return Response.json({ loggedIn: true });
        }
        return Response.json({ ok: true });
      })
    );
    const state = createWorkerState();
    const options = { apiUrl: "http://api.test", pollMs: 1000, ingestIntervalMs: 60_000 };

    const first = await runWorkerCycle(options, state);
    const second = await runWorkerCycle(options, state);

    expect(first.approvedProcessed).toBe(1);
    expect(second.approvedProcessed).toBe(0);
    expect(calls.filter((call) => call === "POST http://api.test/jobs/job_auto/post")).toHaveLength(1);
  });

  it("back-fills a random 30-90 min scheduledFor on legacy autopost jobs with no schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    const calls: string[] = [];
    const patchBodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (init?.body) patchBodies.push(JSON.parse(init.body as string));
        if (url.endsWith("/drafts/pending")) {
          return Response.json({ drafts: [] });
        }
        if (url.endsWith("/jobs/recover-stale")) {
          return Response.json({ recoveredCount: 0, recovered: [] });
        }
        if (url.endsWith("/ingest-run/async")) {
          return Response.json({ accepted: false, ingestRun: { processed: 0, running: true } }, { status: 202 });
        }
        if (url.endsWith("/health")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/jobs") && init?.method !== "PATCH") {
          return Response.json({
            jobs: [{ ...baseJob, id: "job_legacy", mode: "autopost" }]
          });
        }
        if (url.endsWith("/accounts")) {
          return Response.json({ accounts: [baseAccount] });
        }
        if (url.includes("/browser/x-session")) {
          return Response.json({ loggedIn: true });
        }
        return Response.json({ ok: true });
      })
    );
    const state = createWorkerState();
    const options = { apiUrl: "http://api.test", pollMs: 1000, ingestIntervalMs: 60_000 };

    const result = await runWorkerCycle(options, state);

    expect(result.approvedProcessed).toBe(0);
    const patchCalls = calls.filter((call) => call === "PATCH http://api.test/jobs/job_legacy");
    expect(patchCalls).toHaveLength(1);
    const body = patchBodies.find((raw) => {
      const obj = raw as { scheduledFor?: unknown };
      return typeof obj?.scheduledFor === "string";
    }) as { scheduledFor: string } | undefined;
    expect(body).toBeDefined();
    expect(body!.scheduledFor).toBeTruthy();
    const scheduledMs = Date.parse(body!.scheduledFor);
    const nowMs = Date.parse("2026-04-25T12:00:00.000Z");
    const gapMinutes = (scheduledMs - nowMs) / 60_000;
    expect(gapMinutes).toBeGreaterThanOrEqual(30);
    expect(gapMinutes).toBeLessThanOrEqual(90 * 1.2);
  });

  it("recovers stale jobs before processing approved jobs in a worker cycle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/jobs/recover-stale")) {
          return Response.json({ recoveredCount: 1, recovered: [{ id: "job_stale" }] });
        }
        if (url.endsWith("/drafts/pending")) {
          return Response.json({ drafts: [] });
        }
        if (url.endsWith("/ingest-run/async")) {
          return Response.json({ accepted: false, ingestRun: { processed: 0, running: true } }, { status: 202 });
        }
        if (url.endsWith("/health")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/jobs")) {
          return Response.json({ jobs: [] });
        }
        if (url.endsWith("/accounts")) {
          return Response.json({ accounts: [baseAccount] });
        }
        return Response.json({ ok: true });
      })
    );

    const result = await runWorkerCycle(
      { apiUrl: "http://api.test", pollMs: 1000, ingestIntervalMs: 60_000 },
      createWorkerState()
    );

    expect(result.recoveredCount).toBe(1);
    expect(calls[0]).toBe("POST http://api.test/jobs/recover-stale");
  });

  it("continues processing due jobs when one job action fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/health")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/jobs")) {
          return Response.json({
            jobs: [
              { ...baseJob, id: "job_fail", mode: "prepare_only" },
              { ...baseJob, id: "job_ok", mode: "prepare_only" }
            ]
          });
        }
        if (url.endsWith("/accounts")) {
          return Response.json({
            accounts: [baseAccount]
          });
        }
        if (url.endsWith("/jobs/job_fail/prepare")) {
          return Response.json({ error: "browser failed" }, { status: 500 });
        }
        return Response.json({ ok: true });
      })
    );

    const processed = await processApprovedJobs({ apiUrl: "http://api.test", pollMs: 1000 });

    expect(processed).toBe(1);
    expect(calls).toContain("POST http://api.test/jobs/job_fail/prepare");
    expect(calls).toContain("POST http://api.test/jobs/job_ok/prepare");
  });

  it("blocks non-retryable autopost jobs after source packet cap errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/health")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/jobs")) {
          return Response.json({
            jobs: [{ ...baseJob, id: "job_capped", mode: "autopost", scheduledFor: "2026-04-25T11:00:00.000Z" }]
          });
        }
        if (url.endsWith("/accounts")) {
          return Response.json({ accounts: [baseAccount] });
        }
        if (url.includes("/browser/x-session")) {
          return Response.json({ loggedIn: true });
        }
        if (url.endsWith("/jobs/job_capped/post")) {
          return Response.json({ error: "Source packet already reached 2 posts for this account" }, { status: 409 });
        }
        return Response.json({ ok: true });
      })
    );
    const state = createWorkerState();
    const options = { apiUrl: "http://api.test", pollMs: 1000 };

    await processApprovedJobs(options, state);
    await processApprovedJobs(options, state);

    expect(state.blockedAutopostJobIds.has("job_capped")).toBe(true);
    expect(calls.filter((call) => call === "POST http://api.test/jobs/job_capped/post")).toHaveLength(1);
  });

  it("stops submitting more autopost jobs when another browser job is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/health")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/jobs")) {
          return Response.json({
            jobs: [
              { ...baseJob, id: "job_busy", mode: "autopost", scheduledFor: "2026-04-25T11:00:00.000Z" },
              { ...baseJob, id: "job_later", mode: "autopost", scheduledFor: "2026-04-25T11:00:00.000Z" }
            ]
          });
        }
        if (url.endsWith("/accounts")) {
          return Response.json({ accounts: [baseAccount] });
        }
        if (url.includes("/browser/x-session")) {
          return Response.json({ loggedIn: true });
        }
        if (url.endsWith("/jobs/job_busy/post")) {
          return Response.json({ error: "Another browser job is already running for this account" }, { status: 409 });
        }
        return Response.json({ ok: true });
      })
    );

    const processed = await processApprovedJobs({ apiUrl: "http://api.test", pollMs: 1000 }, createWorkerState());

    expect(processed).toBe(0);
    expect(calls).toContain("POST http://api.test/jobs/job_busy/post");
    expect(calls).not.toContain("POST http://api.test/jobs/job_later/post");
  });

  it("skips due jobs during account quiet hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T23:30:00.000Z"));
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/health")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/jobs")) {
          return Response.json({
            jobs: [{ ...baseJob, id: "job_quiet", mode: "prepare_only", scheduledFor: null }]
          });
        }
        if (url.endsWith("/accounts")) {
          return Response.json({
            accounts: [{ ...baseAccount, quietHoursStart: "22:00", quietHoursEnd: "06:00" }]
          });
        }
        return Response.json({ ok: true });
      })
    );

    const processed = await processApprovedJobs({ apiUrl: "http://api.test", pollMs: 1000 });

    expect(processed).toBe(0);
    expect(calls).not.toContain("POST http://api.test/jobs/job_quiet/prepare");
  });
});

describe("worker ingest processing", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs ingest at configured interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    const calls: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/health")) {
          return Response.json({ ok: true });
        }
        if (url.endsWith("/drafts/pending")) {
          return Response.json({ drafts: [] });
        }
        if (url.endsWith("/jobs")) {
          return Response.json({ jobs: [] });
        }
        if (url.endsWith("/ingest-run/async")) {
          return Response.json({ accepted: true, ingestRun: { processed: 0, running: true } }, { status: 202 });
        }
        return Response.json({ ok: true });
      })
    );

    // Simulate worker loop with ingest interval
    const options = { apiUrl: "http://api.test", pollMs: 1000, ingestIntervalMs: 60_000 };
    let lastIngestMs = 0;

    // First iteration - should run ingest since lastIngestMs is 0
    const now = Date.now();
    if (now - lastIngestMs >= options.ingestIntervalMs!) {
      lastIngestMs = now;
      await processIngest(options);
    }

    // Advance time by 30 seconds - should NOT run ingest
    vi.advanceTimersByTime(30_000);
    const after30s = Date.now();
    if (after30s - lastIngestMs >= options.ingestIntervalMs!) {
      await processIngest(options);
    }

    // Advance time by 60 more seconds - SHOULD run ingest
    vi.advanceTimersByTime(60_000);
    const after90s = Date.now();
    if (after90s - lastIngestMs >= options.ingestIntervalMs!) {
      lastIngestMs = after90s;
      await processIngest(options);
    }

    // Should have 2 ingest calls
    expect(calls.filter(c => c.includes("/ingest-run/async"))).toHaveLength(2);
  });

  it("drafts new source packets as autopost jobs", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/source-packets")) {
          return Response.json({
            packets: [
              {
                id: "packet_new",
                accountId: "account_personal",
                sourceType: "news",
                title: "Useful AI source",
                url: "https://example.com/ai",
                summary: "Useful AI source",
                facts: ["Useful AI source"],
                tweetType: "useful_info",
                status: "new",
                createdAt: "2026-04-25T12:00:00.000Z",
                updatedAt: "2026-04-25T12:00:00.000Z"
              },
              {
                id: "packet_drafted",
                accountId: "account_personal",
                sourceType: "news",
                title: "Already drafted",
                url: "https://example.com/drafted",
                summary: "Already drafted",
                facts: ["Already drafted"],
                tweetType: "useful_info",
                status: "drafted",
                createdAt: "2026-04-25T12:00:00.000Z",
                updatedAt: "2026-04-25T12:00:00.000Z"
              }
            ]
          });
        }
        return Response.json({ ok: true });
      })
    );

    const processed = await processNewSourcePackets({ apiUrl: "http://api.test", pollMs: 1000 });

    expect(processed).toBe(1);
    expect(calls).toContain("POST http://api.test/source-packets/packet_new/draft");
    expect(calls).not.toContain("POST http://api.test/source-packets/packet_drafted/draft");
  });
});

describe("worker startup checks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("warns when worker has no enabled ingest config and auto-seed is disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/health")) return Response.json({ ok: true });
        if (url.endsWith("/accounts")) return Response.json({ accounts: [baseAccount] });
        if (url.endsWith("/ingest-configs")) return Response.json({ configs: [] });
        if (url.includes("/browser/x-session")) return Response.json({ loggedIn: true, error: null });
        return Response.json({ ok: true });
      })
    );

    const result = await checkWorkerStartup({
      apiUrl: "http://api.test",
      autoSeedDefaultIngest: false,
      pollMs: 1000
    });

    expect(result.seededConfigId).toBeNull();
    expect(result.warnings).toContain("No enabled ingest configs exist, so worker has no source to pull.");
  });

  it("seeds default news ingest config when no enabled config exists", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/health")) return Response.json({ ok: true });
        if (url.endsWith("/accounts")) return Response.json({ accounts: [baseAccount] });
        if (url.endsWith("/ingest-configs")) return Response.json({ configs: [] });
        if (url.endsWith("/ingest-configs/default-news")) return Response.json({ config: { id: "ingest_default" } }, { status: 201 });
        if (url.includes("/browser/x-session")) return Response.json({ loggedIn: true, error: null });
        return Response.json({ ok: true });
      })
    );

    const result = await checkWorkerStartup({ apiUrl: "http://api.test", pollMs: 1000 });

    expect(result.seededConfigId).toBe("ingest_default");
    expect(result.warnings).toEqual([]);
    expect(calls).toContain("POST http://api.test/ingest-configs/default-news");
  });
});

describe("startWorker", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs at least one cycle after starting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    const cycleCalls: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/health")) return Response.json({ ok: true });
        if (url.endsWith("/accounts")) return Response.json({ accounts: [baseAccount] });
        if (url.endsWith("/ingest-configs")) return Response.json({ configs: [{ id: "cfg1", enabled: true }] });
        if (url.includes("/browser/x-session")) return Response.json({ loggedIn: true, error: null });
        if (url.endsWith("/jobs/recover-stale")) { cycleCalls.push(1); return Response.json({ recoveredCount: 0 }); }
        if (url.endsWith("/jobs")) return Response.json({ jobs: [] });
        if (url.endsWith("/drafts/pending")) return Response.json({ drafts: [] });
        if (url.endsWith("/source-packets")) return Response.json({ packets: [] });
        if (url.endsWith("/ingest-run/async")) return Response.json({ accepted: false, ingestRun: { processed: 0, running: true } });
        return Response.json({ ok: true });
      })
    );

    const handle = startWorker({ apiUrl: "http://api.test", pollMs: 100 });

    // Advance time enough for startup + at least one cycle
    await vi.advanceTimersByTimeAsync(500);
    await handle.stop();

    expect(cycleCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("stop() prevents further cycles from running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    const cycleCalls: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/health")) return Response.json({ ok: true });
        if (url.endsWith("/accounts")) return Response.json({ accounts: [baseAccount] });
        if (url.endsWith("/ingest-configs")) return Response.json({ configs: [{ id: "cfg1", enabled: true }] });
        if (url.includes("/browser/x-session")) return Response.json({ loggedIn: true, error: null });
        if (url.endsWith("/jobs/recover-stale")) { cycleCalls.push(1); return Response.json({ recoveredCount: 0 }); }
        if (url.endsWith("/jobs")) return Response.json({ jobs: [] });
        if (url.endsWith("/drafts/pending")) return Response.json({ drafts: [] });
        if (url.endsWith("/source-packets")) return Response.json({ packets: [] });
        if (url.endsWith("/ingest-run/async")) return Response.json({ accepted: false, ingestRun: { processed: 0, running: true } });
        return Response.json({ ok: true });
      })
    );

    const handle = startWorker({ apiUrl: "http://api.test", pollMs: 100 });

    // Let startup + one cycle run
    await vi.advanceTimersByTimeAsync(500);
    const countBeforeStop = cycleCalls.length;
    expect(countBeforeStop).toBeGreaterThanOrEqual(1);

    await handle.stop();
    const countAfterStop = cycleCalls.length;

    // Advance well beyond the poll interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(cycleCalls.length).toBe(countAfterStop);
  });

  it("stop() waits for an in-flight slow cycle to complete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    let cycleStarted = false;
    let cycleFinished = false;
    let cycleResolve!: () => void;
    const resumePromise = new Promise<void>((resolve) => { cycleResolve = resolve; });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith("/health")) return Response.json({ ok: true });
        if (url.endsWith("/accounts")) return Response.json({ accounts: [baseAccount] });
        if (url.endsWith("/ingest-configs")) return Response.json({ configs: [{ id: "cfg1", enabled: true }] });
        if (url.includes("/browser/x-session")) return Response.json({ loggedIn: true, error: null });
        if (url.endsWith("/jobs/recover-stale")) {
          cycleStarted = true;
          await resumePromise;
          cycleFinished = true;
          return Response.json({ recoveredCount: 0 });
        }
        if (url.endsWith("/jobs")) return Response.json({ jobs: [] });
        if (url.endsWith("/drafts/pending")) return Response.json({ drafts: [] });
        if (url.endsWith("/source-packets")) return Response.json({ packets: [] });
        if (url.endsWith("/ingest-run/async")) return Response.json({ accepted: false, ingestRun: { processed: 0, running: true } });
        return Response.json({ ok: true });
      })
    );

    const handle = startWorker({ apiUrl: "http://api.test", pollMs: 100 });

    // Let startup run + start first cycle (which will hang in recover-stale)
    await vi.advanceTimersByTimeAsync(500);
    expect(cycleStarted).toBe(true);
    expect(cycleFinished).toBe(false);

    // Initiate stop — it should NOT resolve yet since cycle is in-flight
    let stopped = false;
    const stopPromise = handle.stop().then(() => { stopped = true; });

    // Advance time — stop should still be pending
    await vi.advanceTimersByTimeAsync(500);
    expect(stopped).toBe(false);

    // Release the in-flight cycle
    cycleResolve();
    await vi.runAllTimersAsync();
    await stopPromise;

    expect(stopped).toBe(true);
    expect(cycleFinished).toBe(true);
  });

  it("startup failure: finished rejects and stop() still resolves normally", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T12:00:00.000Z"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const startupError = new Error("API unreachable");
    const mockCheckStartup = vi.fn().mockRejectedValue(startupError);

    const handle = startWorker(
      { apiUrl: "http://api.test", pollMs: 100 },
      { checkStartup: mockCheckStartup }
    );

    // finished should reject with the startup error
    await expect(handle.finished).rejects.toThrow("API unreachable");

    // stop() should still resolve normally after a startup failure
    await handle.stop();
    // stop() called twice is idempotent
    await handle.stop();

    expect(mockCheckStartup).toHaveBeenCalledTimes(1);
  });
});
