import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { validateSourcePostQuality } from "@zyquor/automation";
import { prepareJobRequestSchema } from "@zyquor/core";
import { assertDedicatedProfileDir, isAccountRunnable } from "@zyquor/accounts";
import { asHttpError, HttpError } from "../lib/errors.js";
import { tracePostProcessTweetText } from "../lib/post-process.js";
import { browserOptions } from "../lib/browser.js";
import { resolveProfileDir } from "../lib/paths.js";
import { mediaPathsForDraft } from "../lib/media.js";
import { isDailyLimitReached } from "../lib/daily-limit.js";
import { recoverStaleRunningJobs } from "../lib/stale-jobs.js";
import {
  hasPostedTextForAccount,
  hasRunningJobForAccount,
  postedSourcePacketCountForAccount,
  sourcePacketIdForDraft
} from "../lib/source-packet.js";
import { postBrowserJob } from "../lib/post-browser-job.js";

function isScheduledForFuture(job: { scheduledFor: string | null }) {
  return job.scheduledFor ? Date.parse(job.scheduledFor) > Date.now() : false;
}

function browserArtifacts(error: unknown) {
  const maybeError = error as { screenshotPath?: unknown; tracePath?: unknown };
  return {
    screenshotPath: typeof maybeError.screenshotPath === "string" ? maybeError.screenshotPath : null,
    tracePath: typeof maybeError.tracePath === "string" ? maybeError.tracePath : null
  };
}

export function registerJobsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/jobs", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    const jobs = await (await deps.repository).listJobs();
    return {
      jobs: accountId ? jobs.filter((job) => job.accountId === accountId) : jobs
    };
  });

  app.get("/jobs/:id/attempts", async (request) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    return {
      attempts: await repository.listAttempts(id)
    };
  });

  app.post("/jobs/recover-stale", async (request) => {
    const { accountId } = (request.body ?? {}) as { accountId?: string };
    const repository = await deps.repository;
    const recovered = await recoverStaleRunningJobs(repository, accountId ? { accountId } : {});
    return {
      recovered,
      recoveredCount: recovered.length
    };
  });

  app.post("/jobs/post-ready", async (request) => {
    const { accountId } = request.body as { accountId?: string };
    if (!accountId) {
      throw new HttpError(400, "accountId is required");
    }
    const repository = await deps.repository;
    const now = Date.now();
    const readyJobs = (await repository.listJobs())
      .filter((job) => {
        if (job.accountId !== accountId) {
          return false;
        }
        if (job.status !== "approved" && job.status !== "prepared") {
          return false;
        }
        if (!job.scheduledFor) {
          return true;
        }
        return Date.parse(job.scheduledFor) <= now;
      })
      .sort((a, b) => {
        const timeA = Date.parse(a.scheduledFor || a.createdAt);
        const timeB = Date.parse(b.scheduledFor || b.createdAt);
        return timeA - timeB;
      });
    const results = [];

    for (const job of readyJobs) {
      try {
        const result = await postBrowserJob(deps, job.id);
        results.push({
          jobId: job.id,
          status: "posted",
          job: result.job,
          history: result.history,
          error: null
        });
      } catch (error) {
        results.push({
          jobId: job.id,
          status: "failed",
          job: await repository.getJob(job.id),
          history: null,
          error: error instanceof Error ? error.message : "Unknown post error"
        });
      }
    }

    return {
      posted: results.filter((result) => result.status === "posted").length,
      failed: results.filter((result) => result.status === "failed").length,
      total: results.length,
      results
    };
  });

  app.delete("/jobs", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    const repository = await deps.repository;
    const jobs = (await repository.listJobs()).filter((job) => !accountId || job.accountId === accountId);
    const deleted = [];

    for (const job of jobs) {
      if (job.status !== "running") {
        await repository.deleteJob(job.id);
        deleted.push(job.id);
      }
    }

    return { deletedCount: deleted.length, ids: deleted };
  });

  app.delete("/jobs/cleanup", async () => {
    const repository = await deps.repository;
    const jobs = await repository.listJobs();
    const toDelete = jobs.filter((job) => job.status === "posted" || job.status === "failed");
    const deleted = [];

    for (const job of toDelete) {
      await repository.deleteJob(job.id);
      deleted.push(job.id);
    }

    return { deletedCount: deleted.length, ids: deleted };
  });

  app.delete("/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    const job = await repository.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: "Job not found" });
    }
    if (job.status === "running") {
      return reply.code(409).send({ error: "Cannot delete a running job" });
    }

    return { job: await repository.deleteJob(id) };
  });

  app.patch("/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { scheduledFor?: string | null };
    const repository = await deps.repository;
    const job = await repository.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: "Job not found" });
    }
    if (job.status !== "approved" && job.status !== "queued") {
      return reply.code(409).send({ error: `Cannot reschedule a job in status: ${job.status}` });
    }
    if (body.scheduledFor === undefined) {
      return reply.code(400).send({ error: "scheduledFor is required" });
    }
    const scheduledFor = body.scheduledFor === null ? null : body.scheduledFor;
    if (scheduledFor !== null && Number.isNaN(Date.parse(scheduledFor))) {
      return reply.code(400).send({ error: "scheduledFor must be a valid ISO timestamp" });
    }
    const updated = scheduledFor === null
      ? await repository.updateJobStatus(id, job.status)
      : await repository.assignJobSchedule(id, scheduledFor);
    return { job: updated };
  });

  app.post("/jobs/:id/prepare", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    prepareJobRequestSchema.parse({ jobId: id });

    const job = await repository.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: "Job not found" });
    }

    const account = await repository.getAccount(job.accountId);
    const draftWithCandidates = await repository.getDraft(job.draftId);
    const preparedText = draftWithCandidates?.draft.editedText ? tracePostProcessTweetText("prepare-job", draftWithCandidates.draft.editedText) : null;
    if (!account || !preparedText) {
      return reply.code(409).send({ error: "Job is missing account or approved text" });
    }
    const draftForPrepare = draftWithCandidates!.draft;
    if (isScheduledForFuture(job)) {
      return reply.code(409).send({ error: `Job is scheduled for ${job.scheduledFor}` });
    }
    if (!isAccountRunnable(account)) {
      return reply.code(409).send({ error: "Account is not enabled for browser jobs" });
    }
    await recoverStaleRunningJobs(repository, { accountId: account.id, currentJobId: job.id });
    if (await hasRunningJobForAccount(repository, account.id, job.id)) {
      return reply.code(409).send({ error: "Another browser job is already running for this account" });
    }
    assertDedicatedProfileDir(account.profileDir);

    const claimed = await repository.claimJobForBrowserRun(job.id, ["approved", "failed"]);
    if (!claimed) {
      return reply.code(409).send({ error: "Job is already running, posted, or no longer claimable" });
    }
    await repository.updateJobStatus(job.id, "running");
    await repository.createAttempt({ jobId: job.id, status: "started" });

    if (!deps.browser.enablePrepare) {
      const prepared = await repository.updateJobStatus(job.id, "prepared");
      await repository.createAttempt({ jobId: job.id, status: "text_inserted" });
      return { job: prepared, dryRun: true };
    }

    try {
      const preparePost = deps.browser.preparePost ?? (await import("@zyquor/browser")).preparePost;
      deps.browserLoaded = true;
      const mediaPaths = await mediaPathsForDraft(draftForPrepare);
      await preparePost({
        profileDir: resolveProfileDir(account.profileDir),
        text: preparedText,
        replyToUrl: draftForPrepare.replyToUrl ?? null,
        ...(mediaPaths.length ? { mediaPaths } : {}),
        ...browserOptions(deps),
        closeAfterPrepare: deps.browser.closeAfterPrepare ?? true
      });
      const prepared = await repository.updateJobStatus(job.id, "prepared");
      await repository.createAttempt({ jobId: job.id, status: "text_inserted" });
      return { job: prepared, dryRun: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown browser error";
      const artifacts = browserArtifacts(error);
      await repository.updateJobStatus(job.id, "failed");
      await repository.createAttempt({
        jobId: job.id,
        status: "failed",
        errorCode: "browser_prepare_failed",
        errorMessage: message,
        screenshotPath: artifacts.screenshotPath,
        tracePath: artifacts.tracePath
      });
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/jobs/:id/post", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;

    try {
      return await postBrowserJob(deps, id);
    } catch (error) {
      const httpError = asHttpError(error);
      return reply.code(httpError?.statusCode ?? 500).send({
        error: error instanceof Error ? error.message : "Unknown browser error"
      });
    }
  });
}
