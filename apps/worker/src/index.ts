import { loadDotEnv, POST_JOB_STATUSES, type PostJob } from "@zyquor/core";

loadDotEnv();

export interface WorkerOptions {
  apiUrl: string;
  pollMs: number;
}

export function describeWorker() {
  return {
    name: "zyquor-worker",
    supportedJobStatuses: POST_JOB_STATUSES,
    mode: "prepare_only"
  };
}

async function api<T>(apiUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Worker request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function processApprovedJobs(options: WorkerOptions) {
  const { jobs } = await api<{ jobs: PostJob[] }>(options.apiUrl, "/jobs");
  const approvedJobs = jobs.filter((job) => job.status === "approved");

  for (const job of approvedJobs) {
    await api(options.apiUrl, `/jobs/${job.id}/prepare`, { method: "POST" });
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
