import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";

const API_STARTED_AT = new Date().toISOString();

export function registerSystemRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/system/status", async () => {
    const repository = await deps.repository;
    // SQL-side counting; this endpoint is polled every few seconds, so avoid
    // loading whole tables just to compute counts.
    const [statusCounts, runningJobs, packetCount, pendingDrafts, enabledConfigCount] = await Promise.all([
      repository.getPostJobStatusCounts(),
      repository.listJobs(undefined, { statuses: ["running"] }),
      repository.countSourcePackets(),
      repository.countPendingDrafts(),
      repository.countIngestConfigs({ enabled: true })
    ]);

    const jobsByStatus: Record<string, number> = { ...statusCounts };
    const totalJobs = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
    const runningJobMeta = runningJobs.map((job) => ({ accountId: job.accountId, id: job.id, mode: job.mode, updatedAt: job.updatedAt }));
    const heartbeat = deps.workerHeartbeat;
    const desktop = deps.desktopControl ? await deps.desktopControl.status() : null;

    return {
      api: {
        startedAt: API_STARTED_AT,
        browserLoaded: deps.browserLoaded
      },
      counts: {
        drafts: pendingDrafts,
        ingestConfigsEnabled: enabledConfigCount,
        jobs: totalJobs,
        jobsByStatus,
        sourcePackets: packetCount
      },
      desktop,
      runningJobs: runningJobMeta,
      generation: {
        model: deps.generationProvider.model,
        provider: deps.generationProvider.name
      },
      ingestRun: deps.ingestRunState,
      posting: {
        cdpUrl: deps.browser.cdpUrl ?? null,
        channel: deps.browser.channel ?? null,
        enablePost: deps.browser.enablePost,
        enablePrepare: deps.browser.enablePrepare,
        autoApproveSourcePackets: deps.desktopSettings?.get().autoApproveSourcePackets === true
      },
      worker: {
        lastError: heartbeat?.lastError ?? null,
        lastHeartbeatAt: heartbeat?.lastHeartbeatAt ?? null,
        lastIngestAt: heartbeat?.lastIngestAt ?? null,
        lastPostAt: heartbeat?.lastPostAt ?? null,
        paused: desktop?.workerPaused ?? false,
        running: heartbeat !== null && Date.now() - Date.parse(heartbeat.lastHeartbeatAt) < 2 * 60 * 1000
      }
    };
  });

  app.post("/system/posting", async (request) => {
    const body = (request.body ?? {}) as { enablePost?: unknown; enablePrepare?: unknown; autoApproveSourcePackets?: unknown };
    if (typeof body.enablePrepare === "boolean") {
      deps.browser.enablePrepare = body.enablePrepare;
      deps.desktopSettings?.update({ enableBrowserPrepare: body.enablePrepare });
    }
    if (typeof body.enablePost === "boolean") {
      deps.browser.enablePost = body.enablePost;
      deps.desktopSettings?.update({ enableBrowserPost: body.enablePost });
    }
    if (typeof body.autoApproveSourcePackets === "boolean") {
      deps.desktopSettings?.update({ autoApproveSourcePackets: body.autoApproveSourcePackets });
    }
    return {
      enablePost: deps.browser.enablePost,
      enablePrepare: deps.browser.enablePrepare,
      autoApproveSourcePackets: deps.desktopSettings?.get().autoApproveSourcePackets === true
    };
  });

  app.post("/system/ingest/cancel", async () => {
    deps.ingestRunState.cancelRequested = true;
    return { cancelRequested: true, running: deps.ingestRunState.running };
  });

  if (!deps.desktopControl) return;
  const control = deps.desktopControl;

  app.get("/system/logs", async (request) => {
    const { lines } = request.query as { lines?: string };
    const count = Math.min(Math.max(Number(lines ?? 200) || 200, 1), 2000);
    return { lines: await control.logTail(count) };
  });

  app.post("/system/worker/pause", async (request) => {
    const body = (request.body ?? {}) as { paused?: unknown };
    const paused = body.paused !== false;
    return { paused: await control.setWorkerPaused(paused) };
  });

  app.post("/system/chrome/close", async () => control.closeChrome());

  app.post("/system/stop-all", async () => {
    const paused = await control.setWorkerPaused(true);
    deps.browser.enablePost = false;
    deps.browser.enablePrepare = false;
    deps.desktopSettings?.update({ enableBrowserPost: false, enableBrowserPrepare: false });
    deps.ingestRunState.cancelRequested = true;

    const repository = await deps.repository;
    const runningJobs = await repository.listJobs(undefined, { statuses: ["running"] });
    const chrome = runningJobs.length > 0
      ? { closed: false, reason: "job-running" }
      : await control.closeChrome();

    return {
      chrome,
      enablePost: false,
      enablePrepare: false,
      runningJobIds: runningJobs.map((job) => job.id),
      workerPaused: paused
    };
  });

  app.post("/system/quit", async (_request, reply) => {
    void reply.send({ quitting: true });
    setTimeout(() => void control.quit(), 100);
    return reply;
  });

  app.post("/system/restart", async (_request, reply) => {
    void reply.send({ restarting: true });
    setTimeout(() => void control.restart(), 100);
    return reply;
  });
}
