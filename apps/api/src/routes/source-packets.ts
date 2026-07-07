import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { createSourcePacketRequestSchema } from "@zyquor/core";
import { draftFromSourcePacket } from "@zyquor/automation";
import { deleteSourcePacketCascade } from "../lib/source-packet-delete.js";
import { isPostingMode } from "../lib/posting.js";

export function registerSourcePacketsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/source-packets", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    return {
      packets: await (await deps.repository).listSourcePackets(accountId)
    };
  });

  app.delete("/source-packets/:id", async (request) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    const result = await deleteSourcePacketCascade(repository, id);
    return { deleted: true, ...result };
  });

  app.delete("/source-packets", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    const repository = await deps.repository;
    const packets = await repository.listSourcePackets(accountId);
    const jobs = await repository.listJobs();
    const history = await repository.listPostHistory();
    const results = [];

    for (const packet of packets) {
      const draft = await repository.getDraftBySourcePacketId(packet.id);
      if (draft) {
        const draftJobs = jobs.filter((job) => job.draftId === draft.draft.id);
        const hasPostedJob = draftJobs.some((job) => job.status === "posted");
        const hasPostHistory = history.some((item) => item.draftId === draft.draft.id);
        const hasRunningJob = draftJobs.some((job) => job.status === "running");
        if (hasRunningJob) {
          results.push({ deleted: false, draftId: draft.draft.id, packetId: packet.id, reason: "job_running" });
          continue;
        }
        if (!hasPostedJob && !hasPostHistory) {
          await repository.deleteDraft(draft.draft.id);
        }
      }

      await repository.deleteSourcePacket(packet.id);
      results.push({ deleted: true, draftId: draft?.draft.id ?? null, packetId: packet.id, reason: null });
    }

    return {
      deletedCount: results.filter((result) => result.deleted).length,
      skippedCount: results.filter((result) => !result.deleted).length,
      results
    };
  });

  app.post("/source-packets", async (request, reply) => {
    const input = createSourcePacketRequestSchema.parse(request.body);
    const repository = await deps.repository;
    const packet = await repository.createSourcePacket({
      accountId: input.accountId,
      facts: input.facts,
      sourceType: input.sourceType,
      summary: input.summary,
      title: input.title,
      tweetType: input.tweetType,
      url: input.url ?? null
    });

    return reply.code(201).send({ packet });
  });

  app.post("/source-packets/:id/draft", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      autoApprove?: boolean;
      count?: number;
      mode?: string;
    };
    const repository = await deps.repository;
    const packet = await repository.getSourcePacket(id);
    if (!packet) {
      return reply.code(404).send({ error: "Source packet not found" });
    }

    const count = body.count;
    const draftOptions = {
      ...(body.autoApprove === true ? { autoApprove: true } : {}),
      ...(typeof count === "number" && Number.isInteger(count) && count > 0 ? { count } : {}),
      ...(isPostingMode(body.mode) ? { mode: body.mode } : {})
    };
    const draft = await draftFromSourcePacket({
      generationProvider: deps.generationProvider,
      packet,
      repository,
      options: draftOptions
    });

    return reply.code(201).send(draft);
  });

  app.delete("/source-packets/:id/draft", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    const packet = await repository.getSourcePacket(id);
    if (!packet) {
      return reply.code(404).send({ error: "Source packet not found" });
    }

    const existingDraft = await repository.getDraftBySourcePacketId(id);
    if (!existingDraft) {
      return {
        deleted: false,
        draft: null,
        packet: packet.status === "drafted" ? await repository.resetSourcePacket(id) : packet
      };
    }

    try {
      const deleted = await repository.deleteDraft(existingDraft.draft.id);
      const resetPacket = await repository.resetSourcePacket(id);
      return {
        candidates: deleted.candidates,
        deleted: true,
        draft: deleted.draft,
        packet: resetPacket
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown draft delete error";
      return reply.code(409).send({ error: message });
    }
  });
}
