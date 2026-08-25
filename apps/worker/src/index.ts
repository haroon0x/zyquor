import { loadDotEnv, nextAutopostScheduledFor, POST_JOB_STATUSES, type Account, type PostJob, type Draft, type SourcePacket } from "@zyquor/core";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

loadDotEnv();

export interface WorkerOptions {
  apiUrl: string;
  shouldContinue?: () => boolean;
  autoSeedDefaultIngest?: boolean;
  ingestIntervalMs?: number;
  performanceIntervalMs?: number;
  pollMs: number;
}

export interface WorkerHandle {
  finished: Promise<void>;
  isPaused(): boolean;
  setPaused(paused: boolean): void;
  stop(): Promise<void>;
}

export interface WorkerState {
  lastError: string | null;
  lastIngestMs: number;
  lastPerformanceMs: number;
  lastPostMs: number;
  autopostJobIds: Set<string>;
  blockedAutopostJobIds: Set<string>;
}

function pidIsAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function acquireWorkerLock(lockPath = resolve(process.env.ZYQUOR_WORKER_LOCK_PATH ?? resolve(repoRoot, "data/zyquor-worker.lock"))) {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const existingPid = Number(readFileSync(lockPath, "utf8").trim());
    if (pidIsAlive(existingPid)) {
      console.warn(`Another Zyquor worker is already running with pid ${existingPid}. Exiting duplicate worker.`);
      return null;
    }
    rmSync(lockPath, { force: true });
  }

  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      console.warn("Another Zyquor worker acquired the lock first. Exiting duplicate worker.");
      return null;
    }
    throw error;
  }
  writeFileSync(fd, `${process.pid}\n`);
  closeSync(fd);

  const release = () => {
    try {
      const currentPid = Number(readFileSync(lockPath, "utf8").trim());
      if (currentPid === process.pid) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // Lock already removed.
    }
  };
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      release();
      process.exit(0);
    });
  }
  return release;
}

export function postEnabled() {
  return process.env.ZYQUOR_ENABLE_BROWSER_POST === "1";
}

export function createWorkerState(): WorkerState {
  return {
    lastError: null,
    lastIngestMs: 0,
    lastPerformanceMs: 0,
    lastPostMs: 0,
    autopostJobIds: new Set(),
    blockedAutopostJobIds: new Set()
  };
}

function minutesSinceMidnight(time: string) {
  const parts = time.split(":");
  if (parts.length !== 2) {
    return null;
  }
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function isWithinQuietHours(now: Date, account: Account) {
  if (!account.quietHoursStart || !account.quietHoursEnd) {
    return false;
  }
  const start = minutesSinceMidnight(account.quietHoursStart);
  const end = minutesSinceMidnight(account.quietHoursEnd);
  if (start === null || end === null || start === end) {
    return false;
  }
  const current = now.getHours() * 60 + now.getMinutes();
  if (start < end) {
    return current >= start && current < end;
  }
  return current >= start || current < end;
}

export function describeWorker() {
  return {
    name: "zyquor-worker",
    supportedJobStatuses: POST_JOB_STATUSES,
    mode: "prepare_only"
  };
}

async function api<T>(apiUrl: string, path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const headers = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...init?.headers
  };
  const baseUrl = apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = `${baseUrl}${normalizedPath}`;
  const signal = init?.signal ?? (timeoutMs ? AbortSignal.timeout(timeoutMs) : null);

  const response = await fetch(url, {
    ...init,
    headers,
    ...(signal ? { signal } : {})
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    const errorDetail = body?.error ?? body?.message ?? `Status ${response.status}`;
    throw new Error(`Worker request to ${url} failed: ${errorDetail}`);
  }

  return response.json() as Promise<T>;
}

// Single-account rule: the worker only drives jobs for the account whose
// profile the running posting Chrome carries (GET /browser/active).
// - accountId string -> that account is active
// - accountId explicit null -> nothing is activated; nothing may run
// - endpoint error or out-of-contract payload -> "unknown": callers keep the
//   legacy behavior and rely on the API-side 409 post guard as the backstop.
type ActiveAccountState = { state: "active"; accountId: string } | { state: "none" } | { state: "unknown" };

async function fetchActiveAccount(apiUrl: string): Promise<ActiveAccountState> {
  try {
    const data = await api<{ accountId?: string | null }>(apiUrl, "/browser/active");
    if (typeof data.accountId === "string") return { state: "active", accountId: data.accountId };
    return "accountId" in data ? { state: "none" } : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}

export async function heartbeat(options: WorkerOptions, state: WorkerState) {
  try {
    await api(options.apiUrl, "/worker/heartbeat", {
      method: "POST",
      body: JSON.stringify({
        lastError: state.lastError,
        lastIngestAt: state.lastIngestMs > 0 ? new Date(state.lastIngestMs).toISOString() : null,
        lastPostAt: state.lastPostMs > 0 ? new Date(state.lastPostMs).toISOString() : null
      })
    });
  } catch (error) {
    console.error(`Failed to update worker heartbeat:`, error instanceof Error ? error.message : error);
  }
}

export async function checkWorkerStartup(options: WorkerOptions) {
  const warnings: string[] = [];
  let recoveredIngestRunCount = 0;
  let seededConfigId: string | null = null;

  try {
    await api<{ ok: boolean }>(options.apiUrl, "/health");
  } catch (error) {
    warnings.push(`API unreachable at ${options.apiUrl}: ${error instanceof Error ? error.message : error}`);
    return { recoveredIngestRunCount, seededConfigId, warnings };
  }

  if (!postEnabled()) {
    warnings.push("Browser post is disabled, so drafts queue up as approved autopost jobs but never submit to X.");
  }

  const recovery = await api<{ recoveredCount: number }>(
    options.apiUrl,
    "/ingest-runs/recover-stale",
    { method: "POST" }
  );
  recoveredIngestRunCount = recovery.recoveredCount;

  const [{ accounts }, { configs }] = await Promise.all([
    api<{ accounts: Account[] }>(options.apiUrl, "/accounts"),
    api<{ configs: Array<{ enabled: boolean; id: string }> }>(options.apiUrl, "/ingest-configs")
  ]);
  const enabledAccount = accounts.find((account) => account.enabled);
  // Single-account rule: the session check targets the account the running
  // posting Chrome carries. First-enabled is only a fallback for when the
  // active-account endpoint itself is unreachable; an explicit null means no
  // activation and must surface as a warning, not a silent default.
  let sessionAccount: Account | null;
  try {
    const active = await api<{ accountId?: string | null }>(options.apiUrl, "/browser/active");
    if (typeof active.accountId === "string") {
      sessionAccount = accounts.find((account) => account.id === active.accountId) ?? null;
    } else if ("accountId" in active) {
      sessionAccount = null;
    } else {
      // Out-of-contract payload: treat the endpoint as unavailable.
      sessionAccount = enabledAccount ?? null;
    }
  } catch {
    sessionAccount = enabledAccount ?? null;
  }
  const enabledConfigs = configs.filter((config) => config.enabled);

  if (enabledConfigs.length === 0) {
    if (configs.length === 0 && options.autoSeedDefaultIngest !== false && enabledAccount) {
      const seeded = await api<{ config: { id: string } }>(options.apiUrl, "/ingest-configs/default-news", { method: "POST" });
      seededConfigId = seeded.config.id;
    } else {
      warnings.push("No enabled ingest configs exist, so worker has no source to pull.");
    }
  }

  if (!enabledAccount) {
    warnings.push("No enabled account exists for automatic posting.");
  } else if (sessionAccount === null) {
    warnings.push(
      "No activated account: activate one from the account switcher so browser work runs with the intended X login."
    );
  }

  if (enabledAccount && sessionAccount) {
    const browserPrepareEnabled = process.env.ZYQUOR_ENABLE_BROWSER_PREPARE === "1";
    const browserPostEnabled = postEnabled();

    if (!browserPrepareEnabled && !browserPostEnabled) {
      console.log("skipping X session check (browser actions disabled)");
    } else {
      try {
        const session = await api<{ error: string | null; loggedIn: boolean }>(
          options.apiUrl,
          `/browser/x-session?accountId=${encodeURIComponent(sessionAccount.id)}`,
          undefined,
          15_000
        );
        if (!session.loggedIn) {
          warnings.push(`X login missing for ${sessionAccount.id}${session.error ? `: ${session.error}` : ""}`);
        }
      } catch (error) {
        warnings.push(`X login check failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  return { recoveredIngestRunCount, seededConfigId, warnings };
}

function isNonRetryablePostError(message: string) {
  return (
    message.includes("Source packet already reached") ||
    message.includes("Duplicate post text for this account") ||
    message.includes("Daily post limit reached for this account")
  );
}

export async function processApprovedJobs(
  options: WorkerOptions,
  state?: Pick<WorkerState, "autopostJobIds" | "blockedAutopostJobIds">
) {
  // Check health
  try {
    const health = await api<{ ok: boolean }>(options.apiUrl, "/health");
    if (!health.ok) {
      throw new Error("API health check failed");
    }
  } catch (error) {
    console.error(`Cannot reach Zyquor API at ${options.apiUrl}: ${error instanceof Error ? error.message : error}`);
    return 0;
  }

  const [{ jobs }, { accounts }] = await Promise.all([
    api<{ jobs: PostJob[] }>(options.apiUrl, "/jobs"),
    api<{ accounts: Account[] }>(options.apiUrl, "/accounts")
  ]);
  const now = new Date();
  const nowMs = now.getTime();
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  let approvedJobs = jobs.filter((job) => {
    const account = accountById.get(job.accountId);
    if (!account || isWithinQuietHours(now, account)) {
      return false;
    }
    return (
      job.status === "approved" &&
      (!job.scheduledFor || Date.parse(job.scheduledFor) <= nowMs) &&
      (job.mode === "prepare_only" || job.mode === "scheduled" || job.mode === "autopost")
    );
  });

  // Single-account rule: only fire jobs for the account the running posting
  // Chrome carries. With no activation at all, nothing may reach the browser.
  // When the active-account endpoint is unreachable, fall through unfiltered
  // and rely on the API-side 409 post guard.
  const active = await fetchActiveAccount(options.apiUrl);
  if (active.state === "active") {
    const skippedByAccount = new Map<string, number>();
    for (const job of approvedJobs) {
      if (job.accountId !== active.accountId) {
        skippedByAccount.set(job.accountId, (skippedByAccount.get(job.accountId) ?? 0) + 1);
      }
    }
    for (const [accountId, count] of skippedByAccount) {
      const other = accountById.get(accountId);
      console.log(
        `[worker] skipping ${count} job(s) for @${other?.handle ?? accountId} — only the activated account can run; activate it from the account switcher`
      );
    }
    approvedJobs = approvedJobs.filter((job) => job.accountId === active.accountId);
  } else if (active.state === "none") {
    if (approvedJobs.length > 0) {
      console.log(
        `[worker] no activated account — skipping ${approvedJobs.length} browser job(s); activate an account from the account switcher`
      );
    }
    return 0;
  }

  let processed = 0;
  const seenThisRun = new Set<string>();
  const loginByAccount = new Map<string, boolean>();
  for (const job of approvedJobs) {
    if (options.shouldContinue && !options.shouldContinue()) break;
    if (seenThisRun.has(job.id)) {
      continue;
    }
    seenThisRun.add(job.id);

    const action = job.mode === "autopost" ? "post" : "prepare";
    if (action === "post" && !postEnabled()) {
      continue;
    }
    if (action === "post" && state?.autopostJobIds.has(job.id)) {
      continue;
    }
    if (action === "post" && state?.blockedAutopostJobIds.has(job.id)) {
      continue;
    }
    if (action === "post" && !job.scheduledFor) {
      // Legacy autopost jobs (created before the spacing helper, or retried
      // failed posts) may have scheduledFor = null. Back-fill a random 30-90 min
      // gap and persist it before posting, so we never fire two posts back-to-back.
      const recentAccountJobs = approvedJobs
        .filter((other) => other.accountId === job.accountId && other.scheduledFor)
        .map((other) => Date.parse(other.scheduledFor!))
        .filter((ms) => Number.isFinite(ms))
        .sort((a, b) => a - b);
      const recentGapMs: number[] = [];
      for (let i = 1; i < recentAccountJobs.length; i += 1) {
        recentGapMs.push(Math.abs(recentAccountJobs[i]! - recentAccountJobs[i - 1]!));
      }
      const timestamp = new Date().toISOString();
      const next = nextAutopostScheduledFor({
        lastScheduledFor: null,
        timestamp,
        gapMinMinutes: Number(process.env.ZYQUOR_POST_GAP_MIN_MINUTES ?? 40),
        gapMaxMinutes: Number(process.env.ZYQUOR_POST_GAP_MAX_MINUTES ?? 150),
        longPauseChance: Number(process.env.ZYQUOR_POST_LONG_PAUSE_CHANCE ?? 0.15),
        longPauseMinMinutes: Number(process.env.ZYQUOR_POST_LONG_PAUSE_MIN_MINUTES ?? 180),
        longPauseMaxMinutes: Number(process.env.ZYQUOR_POST_LONG_PAUSE_MAX_MINUTES ?? 480),
        recentGapMs,
        traceId: `backfill-${job.id.slice(0, 8)}`
      });
      try {
        await api(options.apiUrl, `/jobs/${job.id}`, {
          method: "PATCH",
          body: JSON.stringify({ scheduledFor: next.scheduledFor })
        });
        job.scheduledFor = next.scheduledFor;
        console.log(`Back-filled autopost job ${job.id} with scheduledFor=${next.scheduledFor} (${next.gapMinutes.toFixed(1)} min)`);
        continue;
      } catch (error) {
        console.error(`Failed to back-fill schedule for ${job.id}:`, error instanceof Error ? error.message : error);
        continue;
      }
    }
    if (action === "post") {
      // Login is verified during browser post by the API (with auto-launch).
    }

    try {
      const traceId = `job-${job.id.slice(0, 8)}-${action}`;
      console.log(`[trace=${traceId}] [worker] firing ${action} account=${job.accountId} mode=${job.mode} scheduledFor=${job.scheduledFor ?? "null"}`);
      await api(options.apiUrl, `/jobs/${job.id}/${action}`, { method: "POST" });
      if (action === "post") {
        state?.autopostJobIds.add(job.id);
        if ("lastPostMs" in (state ?? {})) {
          (state as WorkerState).lastPostMs = Date.now();
        }
        console.log(`[trace=${traceId}] [worker] post-success account=${job.accountId}`);
      }
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (action === "post" && message.includes("Too soon since the last post")) {
        const traceId = `job-${job.id.slice(0, 8)}-post`;
        const match = message.match(/Next post allowed at ([^\s)]+)/);
        if (match?.[1]) {
          const nextEligibleAt = match[1];
          try {
            await api(options.apiUrl, `/jobs/${job.id}`, {
              method: "PATCH",
              body: JSON.stringify({ scheduledFor: nextEligibleAt })
            });
            job.scheduledFor = nextEligibleAt;
            console.log(`[trace=${traceId}] [worker] post-gate rescheduled job ${job.id} scheduledFor=${nextEligibleAt}`);
          } catch (patchError) {
            console.error(
              `[trace=${traceId}] [worker] failed to reschedule job ${job.id} after post-gate: ` +
                `${patchError instanceof Error ? patchError.message : patchError}`
            );
          }
        } else {
          console.log(
            `[trace=${traceId}] [worker] post-gate rejected job ${job.id} with no parseable nextEligibleAt: ${message}`
          );
        }
        continue;
      }
      console.error(`Failed to ${action} job ${job.id}:`, message);
      if (action === "post" && isNonRetryablePostError(message)) {
        state?.blockedAutopostJobIds.add(job.id);
        console.log(`[trace=job-${job.id.slice(0, 8)}-post] [worker] non-retryable error: ${message}`);
      }
      if (action === "post" && message.includes("Another browser job is already running for this account")) {
        break;
      }
    }
  }

  return processed;
}

export async function processPendingDrafts(options: WorkerOptions) {
  const { drafts } = await api<{ drafts: Draft[] }>(options.apiUrl, "/drafts/pending");
  if (drafts.length === 0) return 0;

  let generated = 0;
  for (const draft of drafts) {
    if (options.shouldContinue && !options.shouldContinue()) break;
    try {
      await api(options.apiUrl, `/drafts/${draft.id}/generate`, { method: "POST" });
      generated += 1;
    } catch (error) {
      console.error(`Failed to generate draft ${draft.id}:`, error instanceof Error ? error.message : error);
    }
  }

  return generated;
}

export async function processNewSourcePackets(options: WorkerOptions) {
  const { packets } = await api<{ packets?: SourcePacket[] }>(options.apiUrl, "/source-packets");
  const sourcePackets = packets ?? [];
  const newPackets = sourcePackets.filter((packet) => packet.status === "new");
  if (newPackets.length === 0) return 0;

  let processed = 0;
  for (const packet of newPackets) {
    if (options.shouldContinue && !options.shouldContinue()) break;
    try {
      await api(options.apiUrl, `/source-packets/${packet.id}/draft`, {
        method: "POST",
        body: JSON.stringify({
          autoApprove: true,
          count: 1
        })
      });
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to draft source packet ${packet.id}:`, message);
    }
  }

  return processed;
}

export async function processIngest(options: WorkerOptions) {
  try {
    const result = await api<{ accepted: boolean; ingestRun: { processed: number; running: boolean } }>(
      options.apiUrl,
      "/ingest-run/async",
      { method: "POST" }
    );
    return result.accepted ? 1 : 0;
  } catch (error) {
    console.error(`Failed to run ingest:`, error instanceof Error ? error.message : error);
    return 0;
  }
}

export async function refreshPerformance(options: WorkerOptions) {
  try {
    const result = await api<{ accountId: string; measured: unknown[]; failed: string[] }>(
      options.apiUrl,
      "/performance/refresh",
      { method: "POST" }
    );
    if (result.measured.length > 0) {
      console.log(`[performance] measured ${result.measured.length} post(s)`);
    }
    return result.measured.length;
  } catch (error) {
    console.error(`Failed to refresh post performance:`, error instanceof Error ? error.message : error);
    return 0;
  }
}

export async function recoverStaleJobs(options: WorkerOptions) {
  try {
    const result = await api<{ recoveredCount: number }>(options.apiUrl, "/jobs/recover-stale", { method: "POST" });
    return result.recoveredCount;
  } catch (error) {
    console.error(`Failed to recover stale jobs:`, error instanceof Error ? error.message : error);
    return 0;
  }
}

export async function runWorkerCycle(options: WorkerOptions, state: WorkerState) {
  const keepGoing = () => (options.shouldContinue ? options.shouldContinue() : true);
  state.lastError = null;
  const recoveredCount = await recoverStaleJobs(options);
  if (recoveredCount > 0) {
    console.log(`Recovered ${recoveredCount} stale browser job(s)`);
  }

  const approvedProcessed = keepGoing() ? await processApprovedJobs(options, state) : 0;
  if (approvedProcessed > 0) {
    console.log(`Processed ${approvedProcessed} approved job(s)`);
  }

  const pendingProcessed = keepGoing() ? await processPendingDrafts(options) : 0;
  if (pendingProcessed > 0) {
    console.log(`Generated ${pendingProcessed} pending draft(s)`);
  }

  const sourcePacketProcessed = keepGoing() ? await processNewSourcePackets(options) : 0;
  if (sourcePacketProcessed > 0) {
    console.log(`Drafted ${sourcePacketProcessed} source packet(s)`);
  }

  const now = Date.now();
  if (keepGoing() && now - state.lastIngestMs >= (options.ingestIntervalMs ?? 1 * 60 * 1000)) {
    state.lastIngestMs = now;
    const ingestAccepted = await processIngest(options);
    if (ingestAccepted > 0) {
      console.log("Queued async ingest run");
    }
  }

  const basePerformanceIntervalMs = options.performanceIntervalMs ?? 20 * 60 * 1000;
  const jitteredPerformanceIntervalMs = basePerformanceIntervalMs * (0.6 + 0.8 * Math.random());
  if (keepGoing() && now - state.lastPerformanceMs >= jitteredPerformanceIntervalMs) {
    state.lastPerformanceMs = now;
    await refreshPerformance(options);
  }

  await heartbeat(options, state);

  return { approvedProcessed, pendingProcessed, recoveredCount, sourcePacketProcessed };
}

export function startWorker(
  options: WorkerOptions,
  _deps?: { checkStartup?: typeof checkWorkerStartup }
): WorkerHandle {
  const checkStartup = _deps?.checkStartup ?? checkWorkerStartup;
  const state = createWorkerState();
  let stopping = false;
  let paused = false;
  const cycleOptions: WorkerOptions = {
    ...options,
    shouldContinue: () => !paused && !stopping && (options.shouldContinue ? options.shouldContinue() : true)
  };
  let currentCycle: Promise<void> | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  let finish!: () => void;
  let fail!: (reason: unknown) => void;
  const finished: Promise<void> = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  // Prevent unhandledRejection for embedders who ignore finished.
  // The .catch() creates a separate chain; awaiting finished still sees the rejection.
  finished.catch(() => {});

  (async () => {
    try {
      console.log(describeWorker());
      const startup = await checkStartup(cycleOptions);
      for (const warning of startup.warnings) {
        console.warn(warning);
      }
      if (startup.seededConfigId) {
        console.log(`Seeded default news ingest config ${startup.seededConfigId}`);
      }
      if (startup.recoveredIngestRunCount > 0) {
        console.log(`Marked ${startup.recoveredIngestRunCount} interrupted ingest run(s) as failed`);
      }
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
      console.error(error instanceof Error ? error.message : error);
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const tick = async () => {
      if (stopping) {
        finish();
        return;
      }
      currentCycle = (async () => {
        try {
          if (paused) {
            await heartbeat(options, state);
            return;
          }
          await runWorkerCycle(cycleOptions, state);
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : String(error);
          console.error(error instanceof Error ? error.message : error);
          await heartbeat(cycleOptions, state);
        }
      })();
      await currentCycle;
      currentCycle = null;
      if (stopping) {
        finish();
        return;
      }
      timerId = setTimeout(tick, options.pollMs);
    };

    tick();
  })();

  return {
    finished,
    isPaused() {
      return paused;
    },
    setPaused(next: boolean) {
      paused = next;
    },
    async stop() {
      stopping = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (currentCycle !== null) {
        await currentCycle;
        currentCycle = null;
      }
      finish();
      await finished.catch(() => {});
    }
  };
}

export async function runWorker(options: WorkerOptions) {
  const handle = startWorker(options);
  await handle.finished;
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun && process.env.ZYQUOR_RUN_WORKER === "1") {
  if (!acquireWorkerLock()) {
    process.exit(0);
  }
  await runWorker({
    apiUrl: process.env.ZYQUOR_API_URL ?? "http://127.0.0.1:3000",
    autoSeedDefaultIngest: process.env.ZYQUOR_WORKER_AUTO_SEED_DEFAULT_INGEST !== "0",
    ingestIntervalMs: Number(process.env.ZYQUOR_WORKER_INGEST_INTERVAL_MS ?? 60_000),
    pollMs: Number(process.env.ZYQUOR_WORKER_POLL_MS ?? 5000)
  });
}
