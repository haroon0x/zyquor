import { loadDotEnv, nextAutopostScheduledFor, POST_JOB_STATUSES, type Account, type PostJob, type Draft, type SourcePacket } from "@zyquor/core";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

loadDotEnv();

export interface WorkerOptions {
  apiUrl: string;
  autoSeedDefaultIngest?: boolean;
  ingestIntervalMs?: number;
  pollMs: number;
}

export interface WorkerHandle {
  finished: Promise<void>;
  stop(): Promise<void>;
}

export interface WorkerState {
  lastError: string | null;
  lastIngestMs: number;
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

export function createWorkerState(): WorkerState {
  return {
    lastError: null,
    lastIngestMs: 0,
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

async function api<T>(apiUrl: string, path: string, init?: RequestInit): Promise<T> {
  const headers = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...init?.headers
  };
  const baseUrl = apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = `${baseUrl}${normalizedPath}`;

  const response = await fetch(url, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    const errorDetail = body?.error ?? body?.message ?? `Status ${response.status}`;
    throw new Error(`Worker request to ${url} failed: ${errorDetail}`);
  }

  return response.json() as Promise<T>;
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

  if (process.env.ZYQUOR_ENABLE_BROWSER_POST === "0") {
    warnings.push("ZYQUOR_ENABLE_BROWSER_POST=0, so autopost jobs cannot submit to X.");
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
  const runnableAccount = accounts.find((account) => account.enabled);
  const enabledConfigs = configs.filter((config) => config.enabled);

  if (enabledConfigs.length === 0) {
    if (options.autoSeedDefaultIngest !== false && runnableAccount) {
      const seeded = await api<{ config: { id: string } }>(options.apiUrl, "/ingest-configs/default-news", { method: "POST" });
      seededConfigId = seeded.config.id;
    } else {
      warnings.push("No enabled ingest configs exist, so worker has no source to pull.");
    }
  }

  if (runnableAccount) {
    const browserPrepareEnabled = process.env.ZYQUOR_ENABLE_BROWSER_PREPARE === "1";
    const browserPostEnabled = process.env.ZYQUOR_ENABLE_BROWSER_POST === "1";

    if (!browserPrepareEnabled && !browserPostEnabled) {
      console.log("skipping X session check (browser actions disabled)");
    } else {
      try {
        const session = await api<{ error: string | null; loggedIn: boolean }>(
          options.apiUrl,
          `/browser/x-session?accountId=${encodeURIComponent(runnableAccount.id)}`
        );
        if (!session.loggedIn) {
          warnings.push(`X login missing for ${runnableAccount.id}${session.error ? `: ${session.error}` : ""}`);
        }
      } catch (error) {
        warnings.push(`X login check failed: ${error instanceof Error ? error.message : error}`);
      }
    }
  } else {
    warnings.push("No enabled account exists for automatic posting.");
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
  const approvedJobs = jobs.filter((job) => {
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

  let processed = 0;
  const seenThisRun = new Set<string>();
  const loginByAccount = new Map<string, boolean>();
  for (const job of approvedJobs) {
    if (seenThisRun.has(job.id)) {
      continue;
    }
    seenThisRun.add(job.id);

    const action = job.mode === "autopost" ? "post" : "prepare";
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
        gapMinMinutes: Number(process.env.ZYQUOR_POST_GAP_MIN_MINUTES ?? 30),
        gapMaxMinutes: Number(process.env.ZYQUOR_POST_GAP_MAX_MINUTES ?? 90),
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

  for (const draft of drafts) {
    try {
      await api(options.apiUrl, `/drafts/${draft.id}/generate`, { method: "POST" });
    } catch (error) {
      console.error(`Failed to generate draft ${draft.id}:`, error instanceof Error ? error.message : error);
    }
  }

  return drafts.length;
}

export async function processNewSourcePackets(options: WorkerOptions) {
  const { packets } = await api<{ packets?: SourcePacket[] }>(options.apiUrl, "/source-packets");
  const sourcePackets = packets ?? [];
  const newPackets = sourcePackets.filter((packet) => packet.status === "new");
  if (newPackets.length === 0) return 0;

  let processed = 0;
  for (const packet of newPackets) {
    try {
      await api(options.apiUrl, `/source-packets/${packet.id}/draft`, {
        method: "POST",
        body: JSON.stringify({
          autoApprove: true,
          count: 5,
          mode: "autopost"
        })
      });
      processed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to draft source packet ${packet.id}:`, message);
      if (message.includes("Post text exceeds 280 characters")) {
        await api(options.apiUrl, `/source-packets/${packet.id}`, { method: "DELETE" }).catch(() => null);
      }
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
  state.lastError = null;
  const recoveredCount = await recoverStaleJobs(options);
  if (recoveredCount > 0) {
    console.log(`Recovered ${recoveredCount} stale browser job(s)`);
  }

  const approvedProcessed = await processApprovedJobs(options, state);
  if (approvedProcessed > 0) {
    console.log(`Processed ${approvedProcessed} approved job(s)`);
  }

  const pendingProcessed = await processPendingDrafts(options);
  if (pendingProcessed > 0) {
    console.log(`Generated ${pendingProcessed} pending draft(s)`);
  }

  const sourcePacketProcessed = await processNewSourcePackets(options);
  if (sourcePacketProcessed > 0) {
    console.log(`Drafted ${sourcePacketProcessed} source packet(s)`);
  }

  const now = Date.now();
  if (now - state.lastIngestMs >= (options.ingestIntervalMs ?? 1 * 60 * 1000)) {
    state.lastIngestMs = now;
    const ingestAccepted = await processIngest(options);
    if (ingestAccepted > 0) {
      console.log("Queued async ingest run");
    }
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
      const startup = await checkStartup(options);
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
          await runWorkerCycle(options, state);
        } catch (error) {
          state.lastError = error instanceof Error ? error.message : String(error);
          console.error(error instanceof Error ? error.message : error);
          await heartbeat(options, state);
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
