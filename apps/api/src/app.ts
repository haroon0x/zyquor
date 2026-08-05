import cors from "@fastify/cors";
import { createA16zAdapter, createAggregatedNewsAdapter, createAnthropicReleaseNotesAdapter, createCrawl4AiService, createCursorChangelogAdapter, createDeepSeekUpdatesAdapter, createModelReleasesAdapter, createRssAdapter, createXFeedAdapter, createXaiNewsAdapter, type SourceAdapter } from "@zyquor/adapters";
import { createGenerationProviderFromEnv, evaluateTweetQuality } from "@zyquor/generation";
import { createLocalRepository, type ZyquorRepository } from "@zyquor/storage";
import Fastify from "fastify";
import { ZodError } from "zod";
import { type AppDeps, type BuildAppOptions } from "./deps.js";
import { asError, isConflictError, isGenerationError, HttpError } from "./lib/errors.js";
import { defaultGenerationConfigPath, resolveProfileDir } from "./lib/paths.js";
import { readSavedGenerationEnv } from "./lib/generation.js";
import { registerWorkerRoutes } from "./routes/worker.js";
import { registerGenerationRoutes } from "./routes/generation.js";
import { registerBrowserRoutes } from "./routes/browser.js";
import { registerAccountsRoutes } from "./routes/accounts.js";
import { registerSourcePacketsRoutes } from "./routes/source-packets.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerStyleProfilesRoutes } from "./routes/style-profiles.js";
import { registerSystemFeedbackRoutes } from "./routes/system-feedback.js";
import { registerDraftsRoutes } from "./routes/drafts.js";
import { registerBatchesRoutes } from "./routes/batches.js";
import { registerJobsRoutes } from "./routes/jobs.js";
import { registerHistoryRoutes } from "./routes/history.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerSystemRoutes } from "./routes/system.js";

export { type BuildAppOptions };

function adaptersBySourceType(adapters: SourceAdapter[]) {
  return new Map(adapters.map((adapter) => [adapter.sourceType, adapter]));
}

function createDefaultSourceAdapters(options: {
  repository: Promise<ZyquorRepository>;
  browserChannel?: string | null;
  cdpUrl?: string;
}): SourceAdapter[] {
  const crawlService = createCrawl4AiService();
  return [
    createAggregatedNewsAdapter({ crawlService }),
    createModelReleasesAdapter(),
    createDeepSeekUpdatesAdapter(),
    createCursorChangelogAdapter(),
    createXaiNewsAdapter(),
    createAnthropicReleaseNotesAdapter(),
    createA16zAdapter(),
    createRssAdapter(),
    createXFeedAdapter({
      resolveProfileDir: async (accountId) => {
        const repository = await options.repository;
        const account = await repository.getAccount(accountId);
        return account?.profileDir ? resolveProfileDir(account.profileDir) : null;
      },
      fetchHomeFeed: async (input) => {
        const browser = await import("@zyquor/browser");
        return browser.fetchXHomeFeed({
          ...input,
          ...(options.browserChannel !== undefined ? { browserChannel: options.browserChannel } : {}),
          ...(options.cdpUrl !== undefined ? { cdpUrl: options.cdpUrl } : {})
        });
      }
    })
  ];
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logStream ? { stream: options.logStream as never } : true });
  const repositoryPromise = options.repository ? Promise.resolve(options.repository) : createLocalRepository();
  const sourceAdapters = adaptersBySourceType(options.sourceAdapters ?? createDefaultSourceAdapters({
    repository: repositoryPromise,
    ...(options.browserChannel !== undefined ? { browserChannel: options.browserChannel } : {}),
    ...(options.browserCdpUrl !== undefined ? { cdpUrl: options.browserCdpUrl } : {})
  }));
  const baseGenerationEnv = options.generationEnv ?? process.env;
  const generationConfigPath =
    options.generationConfigPath === undefined
      ? options.repository
        ? null
        : defaultGenerationConfigPath()
      : options.generationConfigPath;

  const deps: AppDeps = {
    repository: repositoryPromise,
    sourceAdapters,
    generationEnv: {
      ...baseGenerationEnv,
      ...readSavedGenerationEnv(generationConfigPath)
    },
    generationProvider: options.generationProvider ?? createGenerationProviderFromEnv({
      ...baseGenerationEnv,
      ...readSavedGenerationEnv(generationConfigPath)
    }),
    tweetQualityEvaluator: options.tweetQualityEvaluator ?? evaluateTweetQuality,
    generationConfigPath,
    launchPostingChrome: options.launchPostingChrome,
    desktopSettings: options.desktopSettings,
    desktopControl: options.desktopControl,
    workerHeartbeat: null,
    ingestRunState: {
      errors: [],
      finishedAt: null,
      lastStartedAt: null,
      processed: 0,
      running: false
    },
    browserLoaded: false,
    onboarding: {
      xSessionCheckedOk: false
    },
    browser: {
      enablePrepare: options.enableBrowserPrepare ?? false,
      enablePost: options.enableBrowserPost ?? false,
      actionDelayMs: options.browserActionDelayMs,
      channel: options.browserChannel,
      cdpUrl: options.browserCdpUrl,
      typingDelayMs: options.browserTypingDelayMs,
      checkXLogin: options.checkXLogin,
      preparePost: options.preparePost,
      closeAfterPrepare: options.closeAfterPrepare,
      closeAfterPost: options.closeAfterPost
    }
  };

  app.register(cors, {
    origin: true
  });

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_request, body: string, done) => {
    if (!body) return done(null, {});
    try {
      done(null, Object.fromEntries(new URLSearchParams(body)));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.setErrorHandler((caught, _request, reply) => {
    const error = asError(caught);
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }

    app.log.error(error);
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 600) {
      return reply.code(statusCode).send({ error: error.message });
    }
    if (isConflictError(error)) {
      return reply.code(409).send({ error: error.message });
    }
    if (isGenerationError(error)) {
      return reply.code(503).send({ error: error.message });
    }

    return reply.code(500).send({ error: error.message });
  });

  registerWorkerRoutes(app, deps);
  registerGenerationRoutes(app, deps);
  registerBrowserRoutes(app, deps);
  registerAccountsRoutes(app, deps);
  registerSourcePacketsRoutes(app, deps);
  registerIngestRoutes(app, deps);
  registerStyleProfilesRoutes(app, deps);
  registerSystemFeedbackRoutes(app, deps);
  registerDraftsRoutes(app, deps);
  registerBatchesRoutes(app, deps);
  registerJobsRoutes(app, deps);
  registerHistoryRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerOnboardingRoutes(app, deps);
  registerSystemRoutes(app, deps);

  return app;
}
