import type { PostAttempt, ReplyTarget } from "@zyquor/core";
import { assertDedicatedProfileDir, isAccountRunnable } from "@zyquor/accounts";
import { browserOptions } from "./browser.js";
import { HttpError } from "./errors.js";
import { resolveProfileDir } from "./paths.js";
import { perProfileCdpUrl } from "./per-profile-cdp.js";
import type { AppDeps } from "../deps.js";

// How deep into the target thread the verification scan looks. A human
// checking "did my reply land" would scroll until convinced; the cap keeps
// the scan bounded even on viral threads.
const RETRY_VERIFICATION_REPLIES = 30;

function compactText(text: string) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

async function recordRetryAttempt(
  repository: Awaited<AppDeps["repository"]>,
  jobId: string,
  attempt: { status: PostAttempt["status"]; errorCode?: string; errorMessage?: string }
) {
  await repository.createAttempt({
    jobId,
    status: attempt.status,
    ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
    ...(attempt.errorMessage ? { errorMessage: attempt.errorMessage } : {})
  });
}

/**
 * Verify-then-retry for failed reply post jobs.
 *
 * A failed attempt is ambiguous: the click usually never happened, but it
 * cannot be proven after the fact. So before reposting anything, scan the
 * target thread through the account's own profile Chrome for a reply by this
 * account matching the approved text.
 * - Found: the reply landed despite the failure. Mark the job posted, record
 *   history, do not repost.
 * - Not found: safe. Flip the job back to approved and run the normal posting
 *   path, which re-applies every gate (login identity, daily cap, spacing,
 *   duplicate text) on the new attempt.
 * If the thread page itself refuses to render, the same question is answered
 * from the account's replies timeline (https://x.com/<handle>/with_replies).
 * Verification itself failing both ways means no safe answer exists: refuse
 * and report.
 */
export async function retryBrowserJob(deps: AppDeps, jobId: string) {
  const repository = await deps.repository;

  const job = await repository.getJob(jobId);
  if (!job) {
    throw new HttpError(404, "Job not found");
  }
  if (job.status === "posted") {
    throw new HttpError(409, "Job is already posted; nothing to retry");
  }
  if (job.status !== "failed") {
    throw new HttpError(409, `Retry applies to failed reply jobs only; this job is ${job.status}`);
  }
  if (!job.replyTo) {
    throw new HttpError(409, "Retry verification supports reply jobs only");
  }
  const replyTo = job.replyTo as ReplyTarget;

  const draftWithCandidates = await repository.getDraft(job.draftId);
  if (!draftWithCandidates || draftWithCandidates.draft.status !== "approved" || !draftWithCandidates.draft.editedText) {
    throw new HttpError(409, "Job's draft is missing approved text; regenerate the draft instead");
  }
  const approvedText = draftWithCandidates.draft.editedText;

  const account = await repository.getAccount(job.accountId);
  if (!account) {
    throw new HttpError(409, "Job is missing its account");
  }
  if (!isAccountRunnable(account)) {
    throw new HttpError(409, "Account is not enabled for browser jobs");
  }
  if (!deps.browser.enablePost) {
    throw new HttpError(403, "Browser retry action is disabled");
  }

  const perProfileCdp = perProfileCdpUrl(deps.browser.cdpUrl ?? "http://127.0.0.1:9222", account.profileDir);
  const browserModule = await import("@zyquor/browser");
  const expectedHandle = account.handle.replace(/^@/, "").toLowerCase();
  const checkXLogin = deps.browser.checkXLogin ?? (async (input: { profileDir: string }) =>
    browserModule.checkXLogin(input));
  const session = await checkXLogin({ profileDir: resolveProfileDir(account.profileDir), ...browserOptions(deps), cdpUrl: perProfileCdp }).catch(
    (error: unknown) => {
      throw new HttpError(
        409,
        `Cannot verify the X login before retrying for @${account.handle}: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  );
  if (!session.loggedIn) {
    throw new HttpError(409, `The posting Chrome is not logged in to X as @${account.handle}. Log in and activate the account first.`);
  }
  if (!session.handle || session.handle !== expectedHandle) {
    throw new HttpError(
      409,
      `Identity mismatch while retrying for @${account.handle}: the posting Chrome is logged in as @${session?.handle ?? "unknown"}. Refusing to act.`
    );
  }
  assertDedicatedProfileDir(account.profileDir);

  const fetchTweet = deps.browser.fetchTweet ?? browserModule.fetchTweet;
  const fetchAccountTimeline = deps.browser.fetchAccountTimeline ?? browserModule.fetchAccountTimeline;
  deps.browserLoaded = true;

  let thread: Awaited<ReturnType<typeof fetchTweet>> | null = null;
  let threadError: string | null = null;
  try {
    thread = await fetchTweet({
      profileDir: resolveProfileDir(account.profileDir),
      url: replyTo.url,
      maxReplies: RETRY_VERIFICATION_REPLIES,
      ...browserOptions(deps),
      cdpUrl: perProfileCdp
    });
  } catch (error) {
    threadError = error instanceof Error ? error.message : "unknown error";
  }

  const replyMatch = (candidates: Array<{ authorHandle: string; text: string; url: string }>) =>
    candidates.find(
      (candidate) =>
        candidate.authorHandle.replace(/^@/, "").toLowerCase() === expectedHandle &&
        compactText(candidate.text) === compactText(approvedText)
    );

  let matched = thread ? replyMatch(thread.replies ?? []) : undefined;
  if (!matched && threadError) {
    // The thread itself will not render (half-loaded status pages happen).
    // X's own profile also proves whether the reply landed: scan the
    // account's replies timeline for the approved text before refusing.
    let timelineError: string | null = null;
    try {
      const timeline = await fetchAccountTimeline({
        profileDir: resolveProfileDir(account.profileDir),
        handle: `${expectedHandle}/with_replies`,
        maxTweets: RETRY_VERIFICATION_REPLIES,
        ...browserOptions(deps),
        cdpUrl: perProfileCdp
      });
      matched = replyMatch(timeline.tweets);
    } catch (error) {
      timelineError = error instanceof Error ? error.message : "unknown error";
    }
    if (!matched && timelineError) {
      throw new HttpError(
        409,
        `Cannot verify the target thread or the account timeline before retrying (thread said: ${threadError}; timeline said: ${timelineError}). Resolve the browser and retry again; nothing was reposted.`
      );
    }
  }
  if (matched) {
    const posted = await repository.updateJobStatus(job.id, "posted");
    await recordRetryAttempt(repository, job.id, { status: "verified" });
    await repository.createPostHistory({
      accountId: account.id,
      draftId: job.draftId,
      postedText: approvedText,
      postUrl: matched.url,
      sourceUrl: replyTo.url,
      tweetType: "reply"
    });
    return { verified: true, job: posted, replyUrl: matched.url };
  }

  // Clean to repost: hand the job back through the ordinary posting path.
  await repository.updateJobStatus(job.id, "approved");
  await recordRetryAttempt(repository, job.id, { status: "retry_scheduled" });
  const { postBrowserJob } = await import("./post-browser-job.js");
  const result = await postBrowserJob(deps, jobId);
  return { verified: false, ...result };
}
