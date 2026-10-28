import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { validateSourcePostQuality, withRequiredSourceUrl } from "@zyquor/automation";
import { POST_JOB_STATUSES, prepareJobRequestSchema, type PostJob } from "@zyquor/core";
import { assertDedicatedProfileDir, isAccountRunnable } from "@zyquor/accounts";
import { asHttpError, HttpError } from "../lib/errors.js";
import { tracePostProcessTweetText } from "../lib/post-process.js";
import { retryBrowserJob } from "../lib/retry-job.js";
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

const ALLOWED_JOB_STATUSES = new Set<string>(POST_JOB_STATUSES);

function parseJobStatuses(raw: string | undefined): PostJob["status"][] | undefined {
  if (!raw) return undefined;
  const statuses = raw
    .split(",")
    .map((status) => status.trim())
    .filter((status) => ALLOWED_JOB_STATUSES.has(status)) as PostJob["status"][];
  return statuses.length > 0 ? statuses : undefined;
}

const MAX_JOB_LIST_LIMIT = 1000;

function parseListLimit(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(Math.floor(parsed), MAX_JOB_LIST_LIMIT);
}

function nextAutopostJob(jobs: PostJob[], accountId: string) {
  return jobs
    .filter(
      (job) =>
        job.accountId === accountId &&
        job.mode === "autopost" &&
        (job.status === "approved" || job.status === "prepared")
    )
    .sort((left, right) => {
      const leftScheduled = left.scheduledFor ? Date.parse(left.scheduledFor) : Number.NEGATIVE_INFINITY;
      const rightScheduled = right.scheduledFor ? Date.parse(right.scheduledFor) : Number.NEGATIVE_INFINITY;
      return leftScheduled - rightScheduled || Date.parse(left.createdAt) - Date.parse(right.createdAt);
    })[0] ?? null;
}

const updateJobScheduleRequestSchema = z.object({
  scheduledFor: z.string().datetime({ offset: true }).nullable()
}).strict();

function shuffle<T>(items: T[]) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[swapIndex]] = [items[swapIndex]!, items[index]!];
  }
  return items;
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
    const { accountId, statuses, limit } = request.query as { accountId?: string; statuses?: string; limit?: string };
    const jobs = await (await deps.repository).listJobs(accountId, {
      statuses: parseJobStatuses(statuses),
      limit: parseListLimit(limit)
    });
    return { jobs };
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

  app.post("/jobs/post-next", async (request, reply) => {
    const { accountId } = request.body as { accountId?: string };
    if (!accountId) {
      throw new HttpError(400, "accountId is required");
    }
    const repository = await deps.repository;
    const job = nextAutopostJob(await repository.listJobs(undefined, { statuses: ["approved", "prepared"] }), accountId);
    if (!job) {
      return reply.code(404).send({ error: "No approved autopost jobs in queue" });
    }

    try {
      return await postBrowserJob(deps, job.id, { bypassSchedule: true, bypassSpacing: true });
    } catch (error) {
      const httpError = asHttpError(error);
      return reply.code(httpError?.statusCode ?? 500).send({
        error: error instanceof Error ? error.message : "Unknown browser error"
      });
    }
  });

  app.post("/jobs/post-ready", async (request) => {
    const { accountId, bypassSpacing } = request.body as { accountId?: string; bypassSpacing?: boolean };
    if (!accountId) {
      throw new HttpError(400, "accountId is required");
    }
    const repository = await deps.repository;
    const now = Date.now();
    const readyJobs = shuffle(
      (await repository.listJobs(accountId, { statuses: ["approved", "prepared"] })).filter((job) => {
        if (job.status !== "approved" && job.status !== "prepared") {
          return false;
        }
        if (!job.scheduledFor) {
          return true;
        }
        return Date.parse(job.scheduledFor) <= now;
      })
    );
    const results = [];

    for (const job of readyJobs) {
      try {
        const result = await postBrowserJob(deps, job.id, { bypassSpacing: Boolean(bypassSpacing) });
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
    const jobs = await repository.listJobs(accountId);
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
    const jobs = await repository.listJobs(undefined, { statuses: ["posted", "failed"] });
    const deleted = [];

    for (const job of jobs) {
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
    const input = updateJobScheduleRequestSchema.parse(request.body);
    const repository = await deps.repository;
    const job = await repository.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: "Job not found" });
    }
    if (["running", "posted", "failed", "cancelled"].includes(job.status)) {
      return reply.code(409).send({ error: `Cannot reschedule a job in status: ${job.status}` });
    }
    return { job: await repository.assignJobSchedule(id, input.scheduledFor) };
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
    const selectedCandidate = draftWithCandidates?.candidates.find((candidate) => candidate.selected);
    const preserveCase = selectedCandidate?.score.provider === deps.generationProvider.name;
    const draftText = draftWithCandidates?.draft.editedText
      ? tracePostProcessTweetText("prepare-job", draftWithCandidates.draft.editedText, preserveCase)
      : null;
    const sourcePacketId = draftWithCandidates ? await sourcePacketIdForDraft(repository, job.draftId) : null;
    const sourcePacket = sourcePacketId ? await repository.getSourcePacket(sourcePacketId) : null;
    const preparedText = draftText && sourcePacket ? withRequiredSourceUrl(draftText, sourcePacket) : draftText;
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
        ...(job.replyTo ? { replyTo: job.replyTo } : {}),
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

  // Verify-then-retry for a failed reply job: scans the target thread for the
  // account's own reply first (marks posted when found), and only reposts
  // through the fully gated path when the thread confirms the reply never
  // landed. Agents never call this on their own; the user asks.
  app.post("/jobs/:id/retry", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await retryBrowserJob(deps, id);
    } catch (error) {
      const httpError = asHttpError(error);
      return reply.code(httpError?.statusCode ?? 500).send({
        error: error instanceof Error ? error.message : "Unknown browser error"
      });
    }
  });
}
