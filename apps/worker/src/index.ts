import { loadDotEnv, POST_JOB_STATUSES, type Account, type PostJob, type Draft } from "@zyquor/core";
import { pathToFileURL } from "node:url";

loadDotEnv();

export interface WorkerOptions {
  apiUrl: string;
  ingestIntervalMs?: number;
  pollMs: number;
}

export interface WorkerState {
  lastIngestMs: number;
  autopostJobIds: Set<string>;
}

export function createWorkerState(): WorkerState {
  return {
    lastIngestMs: 0,
    autopostJobIds: new Set()
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

export async function processApprovedJobs(options: WorkerOptions, state?: Pick<WorkerState, "autopostJobIds">) {
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
  for (const job of approvedJobs) {
    if (seenThisRun.has(job.id)) {
      continue;
    }
    seenThisRun.add(job.id);

    const action = job.mode === "autopost" ? "post" : "prepare";
    if (action === "post" && state?.autopostJobIds.has(job.id)) {
      continue;
    }

    try {
      await api(options.apiUrl, `/jobs/${job.id}/${action}`, { method: "POST" });
      if (action === "post") {
        state?.autopostJobIds.add(job.id);
      }
      processed += 1;
    } catch (error) {
      console.error(
        `Failed to ${action} job ${job.id}:`,
        error instanceof Error ? error.message : error
      );
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

export async function processIngest(options: WorkerOptions) {
  try {
    const result = await api<{ processed: number }>(options.apiUrl, "/ingest-run", { method: "POST" });
    return result.processed;
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
  const recoveredCount = await recoverStaleJobs(options);
  if (recoveredCount > 0) {
    console.log(`Recovered ${recoveredCount} stale browser job(s)`);
  }

  const pendingProcessed = await processPendingDrafts(options);
  if (pendingProcessed > 0) {
    console.log(`Generated ${pendingProcessed} pending draft(s)`);
  }

  const now = Date.now();
  if (now - state.lastIngestMs >= (options.ingestIntervalMs ?? 1 * 60 * 1000)) {
    state.lastIngestMs = now;
    const ingestProcessed = await processIngest(options);
    if (ingestProcessed > 0) {
      console.log(`Ingested ${ingestProcessed} packet(s)`);
    }
  }

  const approvedProcessed = await processApprovedJobs(options, state);
  if (approvedProcessed > 0) {
    console.log(`Processed ${approvedProcessed} approved job(s)`);
  }

  return { approvedProcessed, pendingProcessed, recoveredCount };
}

export async function runWorker(options: WorkerOptions) {
  console.log(describeWorker());
  const state = createWorkerState();

  for (;;) {
    try {
      await runWorkerCycle(options, state);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }

    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isDirectRun && process.env.ZYQUOR_RUN_WORKER === "1") {
  await runWorker({
    apiUrl: process.env.ZYQUOR_API_URL ?? "http://127.0.0.1:3000",
    ingestIntervalMs: Number(process.env.ZYQUOR_WORKER_INGEST_INTERVAL_MS ?? 60_000),
    pollMs: Number(process.env.ZYQUOR_WORKER_POLL_MS ?? 5000)
  });
}
