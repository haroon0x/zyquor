import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { analyzePostHistory } from "@zyquor/core";
import { deleteHistoryPost } from "../lib/delete-history-post.js";
import { asHttpError } from "../lib/errors.js";
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

  app.post("/history/:id/delete", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return await deleteHistoryPost(deps, id);
    } catch (error) {
      const httpError = asHttpError(error);
      return reply.code(httpError?.statusCode ?? 500).send({
        error: error instanceof Error ? error.message : "Unknown browser error"
      });
    }
  });
}
