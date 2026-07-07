import cors from "@fastify/cors";
import { createAggregatedNewsAdapter, createCrawl4AiService, createRssAdapter, type SourceAdapter } from "@zyquor/adapters";
import { createGenerationProviderFromEnv } from "@zyquor/generation";
import { createLocalRepository } from "@zyquor/storage";
import Fastify from "fastify";
import { ZodError } from "zod";
import { type AppDeps, type BuildAppOptions } from "./deps.js";
import { asError, isConflictError, isGenerationError, HttpError } from "./lib/errors.js";
import { defaultGenerationConfigPath } from "./lib/paths.js";
import { readSavedGenerationEnv } from "./lib/generation.js";
import { registerWorkerRoutes } from "./routes/worker.js";
import { registerGenerationRoutes } from "./routes/generation.js";
import { registerBrowserRoutes } from "./routes/browser.js";
import { registerAccountsRoutes } from "./routes/accounts.js";
import { registerSourcePacketsRoutes } from "./routes/source-packets.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { registerStyleProfilesRoutes } from "./routes/style-profiles.js";
import { registerDraftsRoutes } from "./routes/drafts.js";
import { registerBatchesRoutes } from "./routes/batches.js";
import { registerJobsRoutes } from "./routes/jobs.js";
import { registerHistoryRoutes } from "./routes/history.js";

export { type BuildAppOptions };

function adaptersBySourceType(adapters: SourceAdapter[]) {
  return new Map(adapters.map((adapter) => [adapter.sourceType, adapter]));
}

function createDefaultSourceAdapters(): SourceAdapter[] {
  const crawlService = createCrawl4AiService();
  return [createAggregatedNewsAdapter({ crawlService }), createRssAdapter()];
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const repositoryPromise = options.repository ? Promise.resolve(options.repository) : createLocalRepository();
  const sourceAdapters = adaptersBySourceType(options.sourceAdapters ?? createDefaultSourceAdapters());
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
    generationConfigPath,
    workerHeartbeat: null,
    ingestRunState: {
      errors: [],
      finishedAt: null,
      lastStartedAt: null,
      processed: 0,
      running: false
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
  registerDraftsRoutes(app, deps);
  registerBatchesRoutes(app, deps);
  registerJobsRoutes(app, deps);
  registerHistoryRoutes(app, deps);

  return app;
}
