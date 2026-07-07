import type { ZyquorRepository } from "@zyquor/storage";

const DEFAULT_STALE_RUNNING_JOB_MS = 2 * 60 * 1000;

function staleRunningJobMs() {
  const configured = Number(process.env.ZYQUOR_STALE_RUNNING_JOB_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_STALE_RUNNING_JOB_MS;
}

export async function recoverStaleRunningJobs(
  repository: ZyquorRepository,
  options: { accountId?: string; currentJobId?: string } = {}
) {
  const jobs = await repository.listJobs();
  const now = Date.now();
  const staleJobs = jobs.filter(
    (job) =>
      (!options.accountId || job.accountId === options.accountId) &&
      (!options.currentJobId || job.id !== options.currentJobId) &&
      job.status === "running" &&
      now - Date.parse(job.updatedAt) > staleRunningJobMs()
  );
  const recovered = [];

  for (const job of staleJobs) {
    const recoveredJob = await repository.updateJobStatus(job.id, "failed");
    await repository.createAttempt({
      jobId: job.id,
      status: "failed",
      errorCode: "stale_running_job",
      errorMessage:
        job.mode === "autopost"
          ? "Recovered stale running autopost job after interruption. Verify X manually before retrying or deleting."
          : "Recovered stale running browser job after interruption."
    });
    recovered.push(recoveredJob);
  }

  return recovered;
}
