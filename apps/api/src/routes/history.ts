import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { analyzePostHistory } from "@zyquor/core";
import { purgeExpiredPostHistory } from "../lib/history.js";

export function registerHistoryRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/history", async () => {
    const repository = await deps.repository;
    await purgeExpiredPostHistory(repository);
    return {
      history: await repository.listPostHistory()
    };
  });

  app.get("/history/analysis", async (request) => {
    const { accountId, sinceHours } = request.query as { accountId?: string; sinceHours?: string };
    const repository = await deps.repository;
    await purgeExpiredPostHistory(repository);
    const parsedSinceHours = sinceHours ? Number(sinceHours) : undefined;

    return {
      analysis: analyzePostHistory(await repository.listPostHistory(), {
        ...(accountId ? { accountId } : {}),
        ...(Number.isFinite(parsedSinceHours) && parsedSinceHours && parsedSinceHours > 0
          ? { sinceHours: parsedSinceHours }
          : {})
      })
    };
  });
}
