import { afterEach, describe, expect, it, vi } from "vitest";
import { processApprovedJobs, processIngest } from "./index.js";

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
        return Response.json({ ok: true });
      })
    );

    const processed = await processApprovedJobs({ apiUrl: "http://api.test", pollMs: 1000 });

    expect(processed).toBe(1);
    expect(calls).toContain("POST http://api.test/jobs/job_auto/post");
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
        if (url.endsWith("/ingest-run")) {
          return Response.json({ processed: 3 });
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
    expect(calls.filter(c => c.includes("/ingest-run"))).toHaveLength(2);
  });
});
