import type { ZyquorRepository } from "@zyquor/storage";
import { assertDedicatedProfileDir, isAccountRunnable } from "@zyquor/accounts";
import { evaluatePostGate, prepareJobRequestSchema } from "@zyquor/core";
import { browserOptions } from "./browser.js";
import { isDailyLimitReached } from "./daily-limit.js";
import { HttpError } from "./errors.js";
import { mediaPathsForDraft } from "./media.js";
import { perProfileCdpUrl as resolvePerProfileCdpUrl } from "./per-profile-cdp.js";
import { postHistorySnapshot } from "./post-history-snapshot.js";
import { resolveProfileDir } from "./paths.js";
import { tracePostProcessTweetText } from "./post-process.js";
import {
  hasPostedTextForAccount,
  hasRunningJobForAccount,
  postedSourcePacketCountForAccount,
  sourcePacketIdForDraft
} from "./source-packet.js";
import { recoverStaleRunningJobs } from "./stale-jobs.js";
import { validateGeneratedPostQuality, validateSourcePostQuality } from "@zyquor/automation";
import type { AppDeps } from "../deps.js";

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

async function removePostedDraftSourcePacket(repository: ZyquorRepository, draftId: string) {
  const sourcePacketId = await sourcePacketIdForDraft(repository, draftId);
  if (!sourcePacketId) {
    return null;
  }
  const packet = await repository.getSourcePacket(sourcePacketId);
  return packet ? repository.deleteSourcePacket(sourcePacketId) : null;
}

export interface PostBrowserJobOptions {
  bypassSchedule?: boolean;
  bypassSpacing?: boolean;
}

export async function postBrowserJob(deps: AppDeps, jobId: string, options: PostBrowserJobOptions = {}) {
  const repository = await deps.repository;
  prepareJobRequestSchema.parse({ jobId });

  if (!deps.browser.enablePost) {
    throw new HttpError(403, "Browser post action is disabled");
  }

  const job = await repository.getJob(jobId);
  if (!job) {
    throw new HttpError(404, "Job not found");
  }
  if (job.status !== "approved" && job.status !== "prepared") {
    throw new HttpError(409, `Job must be approved or prepared before posting: ${job.status}`);
  }

  const account = await repository.getAccount(job.accountId);
  const draftWithCandidates = await repository.getDraft(job.draftId);
  const selectedCandidate = draftWithCandidates?.candidates.find((candidate) => candidate.selected);
  const preserveCase = selectedCandidate?.score.provider === deps.generationProvider.name;
  const postedText = draftWithCandidates?.draft.editedText
    ? tracePostProcessTweetText("post-job", draftWithCandidates.draft.editedText, preserveCase)
    : null;
  if (!account || !postedText) {
    throw new HttpError(409, "Job is missing account or approved text");
  }
  const draftForPost = draftWithCandidates!.draft;
  if (isScheduledForFuture(job) && !options.bypassSchedule) {
    throw new HttpError(409, `Job is scheduled for ${job.scheduledFor}`);
  }
  if (!isAccountRunnable(account)) {
    throw new HttpError(409, "Account is not enabled for browser jobs");
  }

  const perProfileCdpUrl = resolvePerProfileCdpUrl(deps.browser.cdpUrl ?? "http://127.0.0.1:9222", account.profileDir);

  const browserModuleForGuard = await import("@zyquor/browser");
  const expectedHandle = account.handle.replace(/^@/, "").toLowerCase();
  const checkXLogin = deps.browser.checkXLogin ?? (async (input: { profileDir: string }) =>
    browserModuleForGuard.checkXLogin(input));
  const session = await checkXLogin({ profileDir: resolveProfileDir(account.profileDir), ...browserOptions(deps), cdpUrl: perProfileCdpUrl }).catch(
    (error: unknown) => {
      throw new HttpError(
        409,
        `Cannot verify the X login before posting for @${account.handle}: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  );
  if (!session.loggedIn) {
    throw new HttpError(409, `The posting Chrome is not logged in to X as @${account.handle}. Log in and activate the account first.`);
  }
  if (!session.handle) {
    throw new HttpError(409, `Cannot read which X account is logged in for @${account.handle}; refusing to act rather than guess.`);
  }
  if (session.handle !== expectedHandle) {
    throw new HttpError(
      409,
      `Identity mismatch: the posting Chrome is logged in as @${session.handle}, but this job belongs to @${expectedHandle}. Refusing to post under the wrong account.`
    );
  }

  if (await isDailyLimitReached(repository, account.id, account.dailyPostLimit)) {
    throw new HttpError(409, "Daily post limit reached for this account");
  }

  // Indexed lookup for the newest history row (spacing gate), not a full scan.
  const latestAccountPost = await repository.getLatestPostHistoryForAccount(account.id);
  const gate = evaluatePostGate({
    gapMinMinutes: Number(process.env.ZYQUOR_POST_GAP_MIN_MINUTES ?? 30),
    lastPostedAt: latestAccountPost?.postedAt ?? null,
    now: new Date().toISOString(),
    traceId: `gate-${job.id.slice(0, 8)}`
  });
  if (!gate.allowed && !options.bypassSpacing) {
    throw new HttpError(
      429,
      `Too soon since the last post. Next post allowed at ${gate.nextEligibleAt} (${gate.waitMinutes} min to wait)`
    );
  }
  if (await hasPostedTextForAccount(repository, account.id, postedText)) {
    await repository.updateJobStatus(job.id, "cancelled");
    await repository.createAttempt({
      jobId: job.id,
      status: "failed",
      errorCode: "duplicate_post_text",
      errorMessage: "Duplicate post text for this account"
    });
    throw new HttpError(409, "Duplicate post text for this account");
  }
  const postedSourceCount = await postedSourcePacketCountForAccount(repository, account.id, job.draftId);
  if (postedSourceCount >= 2) {
    await repository.updateJobStatus(job.id, "cancelled");
    await repository.createAttempt({
      jobId: job.id,
      status: "failed",
      errorCode: "source_packet_cap_reached",
      errorMessage: "Source packet already reached 2 posts for this account"
    });
    throw new HttpError(409, "Source packet already reached 2 posts for this account");
  }
  const sourcePacketId = await sourcePacketIdForDraft(repository, job.draftId);
  const sourcePacket = sourcePacketId ? await repository.getSourcePacket(sourcePacketId) : null;
  const sourceQuality = sourcePacket
    ? validateSourcePostQuality({
      history: await repository.listPostHistory(),
      packet: sourcePacket,
      text: postedText
      })
    : null;
  const qualityText = { value: sourceQuality?.text ?? postedText };
  const generatedQualityRequired =
    job.mode === "autopost" &&
    (draftForPost.metadata.yolo === true || draftForPost.metadata.generatedScore !== undefined);
  const generatedQuality = generatedQualityRequired ? validateGeneratedPostQuality(qualityText.value) : null;
  const qualityReasons = [
    ...(sourceQuality?.reasons ?? []),
    ...(generatedQuality?.reasons ?? [])
  ];
  if (qualityReasons.length > 0) {
    const reasons = [...new Set(qualityReasons)];
    await repository.updateJobStatus(job.id, "cancelled");
    await repository.createAttempt({
      jobId: job.id,
      status: "failed",
      errorCode: "post_quality_gate_failed",
      errorMessage: `Post failed quality gate: ${reasons.join(", ")}`
    });
    throw new HttpError(409, `Post failed quality gate: ${reasons.join(", ")}`);
  }
  await recoverStaleRunningJobs(repository, { accountId: account.id, currentJobId: job.id });
  if (await hasRunningJobForAccount(repository, account.id, job.id)) {
    throw new HttpError(409, "Another browser job is already running for this account");
  }
  assertDedicatedProfileDir(account.profileDir);

  const claimed = await repository.claimJobForBrowserRun(job.id, ["approved", "prepared"]);
  if (!claimed) {
    throw new HttpError(409, "Job is already running, posted, or no longer claimable");
  }
  await repository.updateJobStatus(job.id, "running");
  await repository.createAttempt({ jobId: job.id, status: "started" });

  const browserModule = await import("@zyquor/browser");
  deps.browserLoaded = true;

  try {
    const preparePost = deps.browser.preparePost ?? browserModule.preparePost;
    const mediaPaths = await mediaPathsForDraft(draftForPost);
    const result = await preparePost({
      profileDir: resolveProfileDir(account.profileDir),
      text: qualityText.value,
      ...(job.replyTo ? { replyTo: job.replyTo } : {}),
      ...(mediaPaths.length ? { mediaPaths } : {}),
      ...browserOptions(deps),
      cdpUrl: perProfileCdpUrl,
      submit: true
    });
    await repository.createAttempt({ jobId: job.id, status: "post_clicked" });
    const posted = await repository.updateJobStatus(job.id, "posted");
    const history = await repository.createPostHistory({
      accountId: job.accountId,
      draftId: job.draftId,
      postedText: qualityText.value,
      postUrl: result.postUrl,
      ...(await postHistorySnapshot(repository, job.draftId))
    });
    await removePostedDraftSourcePacket(repository, job.draftId);
    await repository.createAttempt({ jobId: job.id, status: "verified" });

    if (deps.browser.closeAfterPost) {
      await browserModule.closeBrowserCdp(perProfileCdpUrl).catch(() => undefined);
    }

    return { job: posted, history };
  } catch (error) {
    if (deps.browser.closeAfterPost) {
      try { const bm = await import("@zyquor/browser"); await bm.closeBrowserCdp(perProfileCdpUrl).catch(() => undefined); } catch {}
    }
    const message = error instanceof Error ? error.message : "Unknown browser error";
    const artifacts = browserArtifacts(error);
    await repository.updateJobStatus(job.id, "failed");
    await repository.createAttempt({
      jobId: job.id,
      status: "failed",
      errorCode: "browser_post_failed",
      errorMessage: message,
      screenshotPath: artifacts.screenshotPath,
      tracePath: artifacts.tracePath
    });
    throw new HttpError(500, message);
  }
}
