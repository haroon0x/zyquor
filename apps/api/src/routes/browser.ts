import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { assertDedicatedProfileDir } from "@zyquor/accounts";
import { browserOptions } from "../lib/browser.js";
import { resolveProfileDir } from "../lib/paths.js";

export function registerBrowserRoutes(app: FastifyInstance, deps: AppDeps): void {
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

  if (deps.launchPostingChrome) {
    app.post("/browser/launch-chrome", async (request, reply) => {
      const { accountId } = (request.body ?? {}) as { accountId?: string };
      const resolvedId = accountId ?? "account_personal";
      const result = await deps.launchPostingChrome!({ accountId: resolvedId });
      return result;
    });
  }
}
