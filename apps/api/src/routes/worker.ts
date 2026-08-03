import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";

export function registerWorkerRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/health", async () => ({
    ok: true,
    browserLoaded: deps.browserLoaded,
    generation: {
      provider: deps.generationProvider.name,
      model: deps.generationProvider.model
    }
  }));

  app.get("/worker/status", async () => {
    const repository = await deps.repository;
    const [configs, jobs, packets] = await Promise.all([
      repository.listIngestConfigs(),
      repository.listJobs(),
      repository.listSourcePackets()
    ]);
    const enabledConfigs = configs.filter((config) => config.enabled);
    const latestPacket = [...packets]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    const latestPosted = jobs
      .filter((job) => job.status === "posted")
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];

    const whb = deps.workerHeartbeat;

    return {
      ok: true,
      enabledIngestConfigCount: enabledConfigs.length,
      hasEnabledIngestConfigs: enabledConfigs.length > 0,
      lastHeartbeatAt: whb?.lastHeartbeatAt ?? null,
      lastIngestAt: whb?.lastIngestAt ?? latestPacket?.createdAt ?? null,
      lastPostAt: whb?.lastPostAt ?? latestPosted?.updatedAt ?? null,
      lastError: whb?.lastError ?? null,
      ingestRun: deps.ingestRunState,
      nextIngestRunAt: whb ? new Date(Date.parse(whb.lastHeartbeatAt) + 60_000).toISOString() : null,
      workerRunning:
        whb !== null && Date.now() - Date.parse(whb.lastHeartbeatAt) < 2 * 60 * 1000
    };
  });

  app.post("/worker/heartbeat", async (request) => {
    const body = (request.body ?? {}) as {
      lastError?: unknown;
      lastIngestAt?: unknown;
      lastPostAt?: unknown;
    };
    deps.workerHeartbeat = {
      lastError: typeof body.lastError === "string" ? body.lastError : null,
      lastHeartbeatAt: new Date().toISOString(),
      lastIngestAt: typeof body.lastIngestAt === "string" ? body.lastIngestAt : null,
      lastPostAt: typeof body.lastPostAt === "string" ? body.lastPostAt : null
    };

    return { ok: true, worker: deps.workerHeartbeat };
  });
}
