import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { assertDedicatedProfileDir } from "@zyquor/accounts";
import { HttpError } from "../lib/errors.js";
import { browserOptions } from "../lib/browser.js";
import { resolveProfileDir } from "../lib/paths.js";

export function registerBrowserRoutes(app: FastifyInstance, deps: AppDeps): void {
  // Single-account rule: activating an account relaunches the posting Chrome
  // with that account's profile. Only the activated account can post.
  app.post("/browser/activate", async (request, reply) => {
    const { accountId } = request.body as { accountId?: string };
    const repository = await deps.repository;
    const accounts = await repository.listAccounts();
    const account = accounts.find((item) => item.id === accountId);
    if (!account) {
      return reply.code(404).send({ error: "Account not found" });
    }

    assertDedicatedProfileDir(account.profileDir);
    const profileDir = resolveProfileDir(account.profileDir);
    const cdpUrl = deps.browser.cdpUrl ?? "http://127.0.0.1:9222";

    const browser = await import("@zyquor/browser");
    deps.browserLoaded = true;

    // The owning launcher (desktop chrome.ts) performs the switch: close the
    // current posting Chrome and relaunch with this account's profile. Only
    // when no launcher is configured (headless API in WSL) do we fall back to
    // the browser package, which launches only when nothing is running.
    if (deps.launchPostingChrome) {
      const result = await deps.launchPostingChrome({ accountId: account.id });
      if (!result.launched && result.reason !== "already-running") {
        throw new HttpError(502, `Could not launch the posting Chrome for @${account.handle}: ${result.reason ?? "unknown"}`);
      }
    } else {
      const launched = await browser.ensureBrowserCdp(cdpUrl, profileDir);
      if (!launched) {
        throw new HttpError(
          409,
          `The running posting Chrome belongs to a different account. Close it, then activate @${account.handle}.`
        );
      }
    }

    const checkXLogin =
      deps.browser.checkXLogin ??
      (async (input: { browserChannel?: string | null; cdpUrl?: string; profileDir: string }) => {
        return browser.checkXLogin(input);
      });
    const session = await checkXLogin({ profileDir, ...browserOptions(deps) }).catch(() => ({ loggedIn: false, handle: null }));

    // Report what we OBSERVED logged in, not what we intended. No persistence:
    // identity is verified live at post time; this response is the operator's
    // immediate confirmation of whose account this Chrome actually carries.
    const expectedHandle = account.handle.replace(/^@/, "").toLowerCase();

    return {
      accountId: account.id,
      handle: account.handle,
      active: true,
      loggedIn: session.loggedIn,
      observedHandle: session.handle ?? null,
      ...(session.handle && session.handle !== expectedHandle
        ? { warning: `Posting Chrome is logged in as @${session.handle}, not @${expectedHandle}. Posting will be refused until the right login is active.` }
        : {})
    };
  });

  // Single-account rule: reports which account the running posting Chrome
  // actually carries, resolved from posting-chrome.json against the account
  // profiles. accountId is null when nothing is activated or the recorded
  // profile matches no known account; callers must treat null as "nothing may
  // run", never as a license to assume a default account.
  // posting-chrome.json is written by whichever OS runs the posting Chrome,
  // so the stored profileDir may be a Windows absolute path while this API
  // runs against a POSIX data root. Compare on the profiles/<name> tail so
  // both spellings of the same dedicated profile resolve to one account.
  function profileTail(profileDir: string): string {
    const normalized = profileDir.replaceAll("\\", "/");
    const marker = "/profiles/";
    const index = normalized.lastIndexOf(marker);
    return index === -1 ? normalized : normalized.slice(index + marker.length);
  }

  app.get("/browser/active", async () => {
    const repository = await deps.repository;
    const accounts = await repository.listAccounts();
    const browser = await import("@zyquor/browser");
    deps.browserLoaded = true;
    const state = browser.readCdpLaunchState();
    if (!state) {
      return { accountId: null, handle: null, profileDir: null };
    }
    const active = accounts.find((item) => profileTail(resolveProfileDir(item.profileDir)) === profileTail(state.profileDir));
    return {
      accountId: active?.id ?? null,
      handle: active?.handle ?? null,
      profileDir: state.profileDir
    };
  });

  app.get("/browser/x-session", async (request, reply) => {
    const repository = await deps.repository;
    const { accountId } = request.query as { accountId?: string };
    const accounts = await repository.listAccounts();
    const account = accounts.find((item) => item.id === (accountId ?? "account_personal")) ?? accounts[0];

    if (!account) {
      return reply.code(404).send({ error: "Account not found" });
    }

    assertDedicatedProfileDir(account.profileDir);
    const profileDir = resolveProfileDir(account.profileDir);

    try {
      const checkXLogin =
        deps.browser.checkXLogin ??
        (async (input: { browserChannel?: string | null; cdpUrl?: string; profileDir: string }) => {
          const browser = await import("@zyquor/browser");
          deps.browserLoaded = true;
          return browser.checkXLogin(input);
        });
      const result = await checkXLogin({
        profileDir,
        ...browserOptions(deps)
      });
      if (result.loggedIn) deps.onboarding.xSessionCheckedOk = true;

      return {
        accountId: account.id,
        cdpUrl: deps.browser.cdpUrl ?? null,
        enabled: deps.browser.enablePrepare === true,
        error: null,
        loggedIn: result.loggedIn,
        observedHandle: result.handle ?? null,
        profileDir,
        url: result.url
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown browser session error";
      return {
        accountId: account.id,
        cdpUrl: deps.browser.cdpUrl ?? null,
        enabled: deps.browser.enablePrepare === true,
        error: message,
        loggedIn: false,
        profileDir,
        url: null
      };
    }
  });

  // Unspecified callers defer to the account whose profile the posting
  // Chrome currently carries. Explicit accountIds must never be remapped:
  // "account_personal" is a real seeded account id, and the launcher no
  // longer second-guesses it (single-account rule).
  async function activeAccountIdFromLaunchState(accounts: Array<{ id: string; profileDir: string }>): Promise<string> {
    try {
      const browser = await import("@zyquor/browser");
      const state = browser.readCdpLaunchState();
      if (!state) return "account_personal";
      const active = accounts.find((item) => resolveProfileDir(item.profileDir) === state.profileDir);
      return active?.id ?? "account_personal";
    } catch {
      return "account_personal";
    }
  }

  if (deps.launchPostingChrome) {
    app.post("/browser/launch-chrome", async (request, reply) => {
      const { accountId } = (request.body ?? {}) as { accountId?: string };
      const repository = await deps.repository;
      const accounts = await repository.listAccounts();
      const resolvedId = accountId ?? (await activeAccountIdFromLaunchState(accounts));
      const result = await deps.launchPostingChrome!({ accountId: resolvedId });
      return result;
    });
  }
}
