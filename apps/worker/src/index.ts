import { loadDotEnv, POST_JOB_STATUSES, type Account, type PostJob } from "@zyquor/core";

loadDotEnv();

export interface WorkerOptions {
  apiUrl: string;
  pollMs: number;
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

export async function processApprovedJobs(options: WorkerOptions) {
  // Run ingest run
  try {
    await api(options.apiUrl, "/ingest-run", { method: "POST" });
  } catch (error) {
    console.error(`Ingest run failed: ${error instanceof Error ? error.message : error}`);
  }

  const [{ jobs }, { accounts }] = await Promise.all([
    api<{ jobs: PostJob[] }>(options.apiUrl, "/jobs"),
    api<{ accounts: Account[] }>(options.apiUrl, "/accounts")
  ]);
  const now = new Date();
  const nowMs = now.getTime();
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const approvedJobs = jobs.filter(
    (job) => {
      const account = accountById.get(job.accountId);
      if (!account || isWithinQuietHours(now, account)) {
        return false;
      }
      return (
      job.status === "approved" &&
      (!job.scheduledFor || Date.parse(job.scheduledFor) <= nowMs) &&
      (job.mode === "prepare_only" || job.mode === "scheduled" || job.mode === "autopost")
      );
    }
  );

  for (const job of approvedJobs) {
    const action = job.mode === "autopost" ? "post" : "prepare";
    await api(options.apiUrl, `/jobs/${job.id}/${action}`, { method: "POST" });
  }

  return approvedJobs.length;
}

export async function runWorker(options: WorkerOptions) {
  console.log(describeWorker());

  for (;;) {
    try {
      const processed = await processApprovedJobs(options);
      if (processed > 0) {
        console.log(`Prepared ${processed} approved job(s)`);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }

    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

if (process.env.ZYQUOR_RUN_WORKER === "1") {
  await runWorker({
    apiUrl: process.env.ZYQUOR_API_URL ?? "http://127.0.0.1:3000",
    pollMs: Number(process.env.ZYQUOR_WORKER_POLL_MS ?? 5000)
  });
}
