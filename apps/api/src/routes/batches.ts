import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { createDraftBatchRequestSchema } from "@zyquor/core";

function addMinutes(timestamp: string, minutes: number) {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
}

export function registerBatchesRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.post("/draft-batches", async (request, reply) => {
    const input = createDraftBatchRequestSchema.parse(request.body);
    if (input.mode === "scheduled" && !input.scheduleStart) {
      return reply.code(400).send({ error: "scheduleStart is required for scheduled batch jobs" });
    }
    const repository = await deps.repository;
    const scheduleSpacingMinutes = input.scheduleSpacingMinutes ?? 90;
    const defaultMode = input.mode ?? (input.scheduleStart ? "scheduled" : "prepare_only");
    const mode = input.yolo && input.autopost ? "autopost" : (input.yolo ? "prepare_only" : defaultMode);
    const created = [];

    for (const [index, idea] of input.ideas.entries()) {
      const draft = await repository.createDraft({
        accountId: input.accountId,
        sourceInput: idea,
        replyToUrl: input.replyToUrl ?? null,
        metadata: {
          lane: "batch",
          yolo: input.yolo,
          autopost: input.autopost,
          mode,
          tweetType: input.tweetType ?? "useful_info",
          scheduleStart: input.scheduleStart ? addMinutes(input.scheduleStart, index * scheduleSpacingMinutes) : null
        }
      });
      created.push(draft);
    }

    return reply.code(201).send({ items: created });
  });
}
