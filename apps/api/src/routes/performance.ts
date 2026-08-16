import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { postPerformanceFromMetadata, type PostHistory } from "@zyquor/core";
import { refreshTweetPerformance } from "../lib/tweet-performance.js";

function historyWithPerformance(history: PostHistory[]) {
  return history.map((item) => ({
    ...item,
    performance: postPerformanceFromMetadata(item.metadata)
  }));
}

export function registerPerformanceRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/performance", async () => {
    const repository = await deps.repository;
    const history = await repository.listPostHistory();
    const measurements = await repository.listTweetMeasurements();
    return {
      history: historyWithPerformance(history),
      measurements
    };
  });

  app.post("/performance/refresh", async () => {
    const result = await refreshTweetPerformance(deps);
    return result;
  });
}