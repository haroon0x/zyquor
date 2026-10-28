import type { ZyquorRepository } from "@zyquor/storage";
import { assertDedicatedProfileDir, isAccountRunnable } from "@zyquor/accounts";
import type { PostAttempt } from "@zyquor/core";
import { browserOptions } from "./browser.js";
import { HttpError } from "./errors.js";
import { resolveProfileDir } from "./paths.js";
import { perProfileCdpUrl } from "./per-profile-cdp.js";
import type { AppDeps } from "../deps.js";

function browserArtifacts(error: unknown) {
  const maybeError = error as { screenshotPath?: unknown; tracePath?: unknown };
  return {
    screenshotPath: typeof maybeError.screenshotPath === "string" ? maybeError.screenshotPath : null,
    tracePath: typeof maybeError.tracePath === "string" ? maybeError.tracePath : null
  };
}

async function recordDeleteAttempt(
  repository: ZyquorRepository,
  draftId: string,
  attempt: { status: PostAttempt["status"]; errorCode?: string; errorMessage?: string; screenshotPath?: string | null; tracePath?: string | null }
) {
  // One indexed lookup per job; the job list used to be loaded whole for this.
  const draftJobs = await repository.listJobsByDraftId(draftId).catch(() => []);
  const job = draftJobs[0];
  if (!job) return;
  await repository
    .createAttempt({
      jobId: job.id,
      status: attempt.status,
      ...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
      ...(attempt.errorMessage ? { errorMessage: attempt.errorMessage } : {}),
      ...(attempt.screenshotPath ? { screenshotPath: attempt.screenshotPath } : {}),
      ...(attempt.tracePath ? { tracePath: attempt.tracePath } : {})
    })
    .catch(() => undefined);
}

/** Browser-driven deletion of a live X post recorded in history. Explicit,
 * per-tweet, and gated behind the same browser-post flag as the Post click. */
export async function deleteHistoryPost(deps: AppDeps, historyId: string) {
  const repository = await deps.repository;

  const history = await repository.getPostHistory(historyId);
  if (!history) {
    throw new HttpError(404, "History entry not found");
  }
  if (typeof history.metadata?.deletedAt === "string") {
    return { history, alreadyDeleted: true };
  }
  if (!history.postUrl) {
    throw new HttpError(409, "History entry has no post URL; cannot locate the tweet on X");
  }
  if (!deps.browser.enablePost) {
    throw new HttpError(403, "Browser delete action is disabled");
  }

  const account = await repository.getAccount(history.accountId);
  if (!account) {
    throw new HttpError(409, "History entry is missing its account");
  }
  if (!isAccountRunnable(account)) {
    throw new HttpError(409, "Account is not enabled for browser jobs");
  }

  const profileCdpUrl = perProfileCdpUrl(deps.browser.cdpUrl ?? "http://127.0.0.1:9222", account.profileDir);
  const browserModule = await import("@zyquor/browser");
  const expectedHandle = account.handle.replace(/^@/, "").toLowerCase();
  const checkXLogin = deps.browser.checkXLogin ?? (async (input: { profileDir: string }) =>
    browserModule.checkXLogin(input));
  const session = await checkXLogin({ profileDir: resolveProfileDir(account.profileDir), ...browserOptions(deps), cdpUrl: profileCdpUrl }).catch(
    (error: unknown) => {
      throw new HttpError(
        409,
        `Cannot verify the X login before deleting for @${account.handle}: ${error instanceof Error ? error.message : "unknown error"}`
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
      `Identity mismatch: the posting Chrome is logged in as @${session.handle}, but this post belongs to @${expectedHandle}. Refusing to delete under the wrong account.`
    );
  }
  assertDedicatedProfileDir(account.profileDir);

  deps.browserLoaded = true;
  await recordDeleteAttempt(repository, history.draftId, { status: "started" });

  try {
    const deletePost = deps.browser.deletePost ?? browserModule.deletePost;
    const result = await deletePost({
      profileDir: resolveProfileDir(account.profileDir),
      postUrl: history.postUrl,
      ...browserOptions(deps),
      cdpUrl: profileCdpUrl
    });
    const updated = await repository.updatePostHistoryMetadata(history.id, {
      ...history.metadata,
      deletedAt: new Date().toISOString(),
      deletedVia: "browser",
      ...(result.alreadyDeleted ? { alreadyDeleted: true } : {})
    });
    await recordDeleteAttempt(repository, history.draftId, { status: "verified" });
    if (deps.browser.closeAfterPost) {
      await browserModule.closeBrowserCdp(profileCdpUrl).catch(() => undefined);
    }
    return { history: updated ?? history, alreadyDeleted: result.alreadyDeleted };
  } catch (error) {
    if (deps.browser.closeAfterPost) {
      try { const bm = await import("@zyquor/browser"); await bm.closeBrowserCdp(profileCdpUrl).catch(() => undefined); } catch {}
    }
    const message = error instanceof Error ? error.message : "Unknown browser error";
    const artifacts = browserArtifacts(error);
    await recordDeleteAttempt(repository, history.draftId, {
      status: "failed",
      errorCode: "browser_delete_failed",
      errorMessage: message,
      screenshotPath: artifacts.screenshotPath,
      tracePath: artifacts.tracePath
    });
    throw new HttpError(500, message);
  }
}
