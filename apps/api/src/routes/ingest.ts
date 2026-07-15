import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import {
  createIngestConfigRequestSchema,
  updateIngestConfigRequestSchema
} from "@zyquor/core";
import { runAutomaticIngest } from "@zyquor/automation";
import { getAggregatedSourceHealth } from "@zyquor/adapters";
import { definedEntries } from "../lib/utils.js";

export function registerIngestRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/ingest-runs", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    return {
      runs: await (await deps.repository).listIngestRuns(accountId, 50)
    };
  });

  app.post("/ingest-runs/recover-stale", async () => {
    if (deps.ingestRunState.running) {
      return { recoveredCount: 0 };
    }
    const recoveredCount = await (await deps.repository).recoverRunningIngestRuns();
    return { recoveredCount };
  });

  app.get("/ingest-configs", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    return {
      configs: await (await deps.repository).listIngestConfigs(accountId)
    };
  });

  app.get("/ingest-sources", async () => ({
    sources: [...deps.sourceAdapters.values()].map((adapter) => ({
      health: adapter.name === "aggregated-news" ? getAggregatedSourceHealth() : null,
      name: adapter.name,
      sourceType: adapter.sourceType
    }))
  }));

  app.post("/ingest-configs", async (request, reply) => {
    const input = createIngestConfigRequestSchema.parse(request.body);
    const repository = await deps.repository;
    const config = await repository.createIngestConfig({
      accountId: input.accountId,
      sourceType: input.sourceType,
      maxPacketsPerDay: input.maxPacketsPerDay,
      metadata: input.metadata,
      tweetTypeMix: input.tweetTypeMix,
      scheduleWindowStart: input.scheduleWindowStart,
      scheduleWindowEnd: input.scheduleWindowEnd,
      enabled: input.enabled
    });

    return reply.code(201).send({ config });
  });

  app.post("/ingest-configs/default-news", async (_request, reply) => {
    const repository = await deps.repository;
    const configs = await repository.listIngestConfigs();
    const existing = configs.find((config) => config.enabled && config.sourceType === "news");
    if (existing) {
      return { config: existing, created: false };
    }

    const accounts = await repository.listAccounts();
    const account = accounts.find((item) => item.enabled) ?? accounts[0];
    if (!account) {
      return reply.code(409).send({ error: "No account available for default ingest config" });
    }

    const config = await repository.createIngestConfig({
      accountId: account.id,
      enabled: true,
      maxPacketsPerDay: 1000,
      metadata: {
        includeArxiv: true,
        includeCompanyRss: true,
        includeExpandedHackerNews: true,
        includeGitHub: true,
        includeHiring: true,
        includeProductHunt: true,
        includeReddit: true,
        includeTechCrunch: true,
        maxItems: 100,
        requireTopicMatch: false
      },
      scheduleWindowEnd: "23:59",
      scheduleWindowStart: "00:00",
      sourceType: "news",
      tweetTypeMix: {
        article_summary: 20,
        feed_observation: 25,
        narrative_history: 15,
        useful_info: 55
      }
    });

    return reply.code(201).send({ config, created: true });
  });

  app.patch("/ingest-configs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateIngestConfigRequestSchema.parse(request.body);
    const repository = await deps.repository;

    try {
      return {
        config: await repository.updateIngestConfig(id, definedEntries(input))
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return reply.code(404).send({ error: "Ingest config not found" });
      }
      throw error;
    }
  });

  app.delete("/ingest-configs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;

    try {
      return { config: await repository.deleteIngestConfig(id) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return reply.code(404).send({ error: "Ingest config not found" });
      }
      throw error;
    }
  });

  app.post("/ingest-run", async (request, reply) => {
    const repository = await deps.repository;
    const result = await runAutomaticIngest({
      adapters: deps.sourceAdapters,
      generationProvider: deps.generationProvider,
      repository
    });

    for (const error of result.errors) {
      app.log.error(`Ingest run failed for config ${error.configId}: ${error.error}`);
    }

    return result;
  });

  app.post("/ingest-run/async", async (request, reply) => {
    if (deps.ingestRunState.running) {
      return reply.code(202).send({ accepted: false, ingestRun: deps.ingestRunState, reason: "already_running" });
    }

    const repository = await deps.repository;
    const configs = (await repository.listIngestConfigs()).filter((config) => config.enabled);
    const runs = await Promise.all(
      configs.map((config) => repository.createIngestRun({ configId: config.id, accountId: config.accountId }))
    );

    deps.ingestRunState = {
      errors: [],
      finishedAt: null,
      lastStartedAt: new Date().toISOString(),
      processed: 0,
      running: true
    };

    void (async () => {
      try {
        const result = await runAutomaticIngest({
          adapters: deps.sourceAdapters,
          generationProvider: deps.generationProvider,
          repository
        });
        for (const error of result.errors) {
          app.log.error(`Async ingest run failed for config ${error.configId}: ${error.error}`);
        }
        await Promise.all(
          runs.map((run) => {
            const errors = result.errors.filter((error) => error.configId === run.configId);
            const packetsCreated = result.results.filter((item) => item.configId === run.configId).length;
            return repository.updateIngestRun(run.id, {
              status: errors.length > 0 ? "failed" : "succeeded",
              error: errors.length > 0 ? errors.map((item) => item.error).join("; ") : null,
              packetsCreated
            });
          })
        );
        deps.ingestRunState = {
          errors: result.errors,
          finishedAt: new Date().toISOString(),
          lastStartedAt: deps.ingestRunState.lastStartedAt,
          processed: result.processed,
          running: false,
          skippedByReason: result.skippedByReason
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown ingest error";
        app.log.error(`Async ingest run failed: ${message}`);
        await Promise.all(
          runs.map((run) => repository.updateIngestRun(run.id, { status: "failed", error: message, packetsCreated: 0 }))
        ).catch((persistError) => {
          app.log.error(`Failed to persist async ingest failure: ${persistError instanceof Error ? persistError.message : persistError}`);
        });
        deps.ingestRunState = {
          errors: [{ configId: "unknown", error: message }],
          finishedAt: new Date().toISOString(),
          lastStartedAt: deps.ingestRunState.lastStartedAt,
          processed: 0,
          running: false
        };
      }
    })();

    return reply.code(202).send({ accepted: true, ingestRun: deps.ingestRunState });
  });
}
