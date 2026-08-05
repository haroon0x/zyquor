import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { createSourcePacketRequestSchema, setSourcePacketFeedbackRequestSchema } from "@zyquor/core";
import { draftFromSourcePacket } from "@zyquor/automation";
import { deleteSourcePacketCascade } from "../lib/source-packet-delete.js";
import { appendNotebookEntry, resolveFeedbackDir } from "../lib/feedback-notebook.js";

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

    const requestedAutoApprove = body.autoApprove === true || body.mode === "autopost";
    const autoApproveAllowed =
      deps.browser.enablePost === true &&
      (deps.desktopSettings ? deps.desktopSettings.get().autoApproveSourcePackets === true : true);
    const autoApprove = requestedAutoApprove && autoApproveAllowed;
    if (requestedAutoApprove && !autoApproveAllowed) {
      app.log.warn(`Auto-approve requested for packet ${id} but automated posting is off; drafting for review`);
    }
    const count = body.count;
    const draftOptions = {
      ...(typeof count === "number" && Number.isInteger(count) && count > 0 ? { count } : {}),
      ...(autoApprove
        ? {
            autoApprove: true,
            mode: "autopost" as const
          }
        : {})
    };

    let draft;
    try {
      draft = await draftFromSourcePacket({
        generationProvider: deps.generationProvider,
        packet,
        repository,
        options: draftOptions
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("returned no draft candidates")) {
        await repository.setSourcePacketStatus(id, "archived");
        app.log.warn(`Archived source packet ${id}: generation dropped all candidates`);
      }
      throw error;
    }

    return reply.code(201).send(draft);
  });

  app.get("/source-packets/:id/draft", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    const existingDraft = await repository.getDraftBySourcePacketId(id);
    if (!existingDraft) {
      return reply.code(404).send({ error: "No draft for this source packet" });
    }
    return { draft: existingDraft.draft, candidates: existingDraft.candidates };
  });

  app.post("/source-packets/:id/regenerate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = setSourcePacketFeedbackRequestSchema.parse(request.body);
    const repository = await deps.repository;
    const notebookDir = resolveFeedbackDir(deps.desktopSettings?.get().feedbackDir);
    const packet = await repository.getSourcePacket(id);
    if (!packet) {
      return reply.code(404).send({ error: "Source packet not found" });
    }
    const feedback = input.feedback?.trim() || null;
    if (!feedback) {
      return reply.code(400).send({ error: "Feedback is required to regenerate" });
    }

    const existingDraft = await repository.getDraftBySourcePacketId(id);
    let replacedJobIds: string[] = [];
    if (existingDraft) {
      const jobs = await repository.listJobs();
      const history = await repository.listPostHistory();
      const draftJobs = jobs.filter((job) => job.draftId === existingDraft.draft.id);
      const hasPostedJob = draftJobs.some((job) => job.status === "posted");
      const hasPostHistory = history.some((item) => item.draftId === existingDraft.draft.id);
      const hasRunningJob = draftJobs.some((job) => job.status === "running");
      if (hasRunningJob) {
        return reply.code(409).send({ error: "A post job is still running for this draft" });
      }
      if (hasPostedJob || hasPostHistory) {
        return reply.code(409).send({ error: "This post was already posted; feedback cannot rewrite it" });
      }
      const approvedJobs = draftJobs.filter((job) => job.status === "approved");
      if (approvedJobs.length > 0) {
        replacedJobIds = approvedJobs.map((job) => job.id);
        app.log.warn(
          `Regenerate ${id}: replacing approved job(s) ${replacedJobIds.join(", ")} for draft ${existingDraft.draft.id}`
        );
      }
    }

    await repository.setSourcePacketFeedback(id, feedback);
    const refreshed = (await repository.getSourcePacket(id))!;
    appendNotebookEntry({
      dir: notebookDir,
      heading: `[post] ${new Date().toISOString()} — ${refreshed.tweetType} — ${refreshed.title}`,
      lines: [
        `Source: ${refreshed.sourceType} · packet ${refreshed.id}${refreshed.url ? ` · ${refreshed.url}` : ""}`,
        "",
        "Last generated post:",
        `> ${existingDraft?.draft.editedText ?? existingDraft?.draft.generatedText ?? "(none)"}`,
        "",
        "Feedback:",
        `> ${feedback}`
      ]
    });

    let result;
    try {
      result = await draftFromSourcePacket({
        generationProvider: deps.generationProvider,
        packet: refreshed,
        repository,
        options: {}
      });
    } catch (error) {
      app.log.error(
        `Regenerate failed for source packet ${id}; keeping existing draft intact: ` +
          `${error instanceof Error ? error.message : error}`
      );
      throw error;
    }

    if (existingDraft && existingDraft.draft.id !== result.draft.id) {
      try {
        await repository.deleteDraft(existingDraft.draft.id);
      } catch (error) {
        app.log.warn(
          `Regenerate ${id}: failed to remove replaced draft ${existingDraft.draft.id}: ` +
            `${error instanceof Error ? error.message : error}`
        );
      }
    }

    const newText = result.candidates[0]?.text ?? "";
    appendNotebookEntry({
      dir: notebookDir,
      heading: `[regenerated] ${result.draft.id}`,
      lines: ["Rewritten after feedback:", `> ${newText}`]
    });

    return reply.code(201).send({
      ...result,
      ...(replacedJobIds.length > 0 ? { replacedJobIds } : {})
    });
  });

  app.post("/source-packets/:id/feedback", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = setSourcePacketFeedbackRequestSchema.parse(request.body);
    const repository = await deps.repository;
    const packet = await repository.getSourcePacket(id);
    if (!packet) {
      return reply.code(404).send({ error: "Source packet not found" });
    }
    const feedback = input.feedback?.trim() || null;
    const updated = await repository.setSourcePacketFeedback(id, feedback);
    if (feedback) {
      const notebookDir = resolveFeedbackDir(deps.desktopSettings?.get().feedbackDir);
      appendNotebookEntry({
        dir: notebookDir,
        heading: `[post] ${new Date().toISOString()} — ${updated.tweetType} — ${updated.title}`,
        lines: [
          `Source: ${updated.sourceType} · packet ${updated.id}${updated.url ? ` · ${updated.url}` : ""}`,
          "",
          "Feedback (saved without regenerating):",
          `> ${feedback}`
        ]
      });
    }
    return { packet: updated };
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
