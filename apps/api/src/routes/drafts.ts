import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import {
  approveDraftRequestSchema,
  createDraftRequestSchema,
  selectDraftCandidateRequestSchema,
  AI_SLOP_PHRASES,
  parseReplyTargetUrl
} from "@zyquor/core";
import { accountGenerationContext } from "@zyquor/automation";
import { tracePostProcessTweetText } from "../lib/post-process.js";
import { isPostingMode } from "../lib/posting.js";

export function registerDraftsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/drafts/pending", async () => {
    const repository = await deps.repository;
    return { drafts: await repository.listPendingDrafts() };
  });

  app.post("/drafts/:id/generate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    const existing = await repository.getDraft(id);
    if (!existing || existing.draft.status !== "created") {
      return reply.code(404).send({ error: "Draft not found or already generated" });
    }

    const draft = existing.draft;
    const metadata = draft.metadata as Record<string, unknown>;
    const context = await accountGenerationContext(repository, draft.accountId);
    const count = metadata.yolo ? 1 : (Number(metadata.count) || 3);

    const candidates = await deps.generationProvider.generateDraftCandidates({
      idea: draft.sourceInput,
      count,
      ...context,
      ...(draft.replyTo
        ? { tweetType: "reply" }
        : metadata.tweetType
          ? { tweetType: metadata.tweetType as string }
          : {}),
      ...(draft.replyTo
        ? { replyContext: { authorHandle: draft.replyTo.authorHandle, url: draft.replyTo.url } }
        : {})
    });

    const updated = await repository.saveDraftCandidates(
      draft.id,
      candidates.map((candidate) => ({
        ...candidate,
        text: tracePostProcessTweetText("select-candidate", candidate.text)
      }))
    );

    if (metadata.yolo) {
      const qualityMin = Number(process.env.ZYQUOR_QUALITY_MIN ?? 3);
      const sortedCandidates = [...updated.candidates].sort(
        (a, b) => Number(b.score.quality ?? -Infinity) - Number(a.score.quality ?? -Infinity)
      );
      const bestCandidate = sortedCandidates[0];
      const bestQuality = Number(bestCandidate?.score.quality ?? -Infinity);
      const slopPhrase = bestCandidate
        ? AI_SLOP_PHRASES.find((phrase) => bestCandidate.text.toLowerCase().includes(phrase)) ?? null
        : null;
      if (!bestCandidate || bestQuality < qualityMin || slopPhrase) {
        await repository.updateDraftMetadata(draft.id, {
          ...metadata,
          qualityGate: {
            bestQuality: Number.isFinite(bestQuality) ? bestQuality : null,
            bestCandidateId: bestCandidate?.id ?? null,
            threshold: qualityMin,
            slopPhrase,
            rejectedAt: new Date().toISOString(),
            reason: slopPhrase ? "ai_slop_phrase_detected" : "all_below_quality_floor"
          }
        });
        return reply.code(201).send({
          draft: (await repository.getDraft(draft.id))?.draft,
          candidates: updated.candidates,
          reason: slopPhrase ? "ai_slop_phrase_detected" : "all_below_quality_floor",
          bestQuality: Number.isFinite(bestQuality) ? bestQuality : null,
          threshold: qualityMin,
          slopPhrase
        });
      }
      const selectedText = bestCandidate.text;
      if (selectedText) {
        const mode = metadata.autopost ? "autopost" : isPostingMode(metadata.mode) ? metadata.mode : "prepare_only";
        const approved = await repository.approveDraft({
          draftId: draft.id,
          editedText: tracePostProcessTweetText("manual-select", selectedText),
          mode,
          ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
          scheduledFor: (metadata.scheduleStart as string | null | undefined) ?? null
        });
        return reply.code(201).send({ ...approved, candidates: updated.candidates });
      }
    }

    return reply.code(201).send(updated);
  });

  app.post("/drafts", async (request, reply) => {
    const rawReplyToUrl = (request.body as { replyToUrl?: unknown } | null)?.replyToUrl;
    const replyTo = typeof rawReplyToUrl === "string" ? parseReplyTargetUrl(rawReplyToUrl) : null;
    if (rawReplyToUrl !== undefined && !replyTo) {
      return reply.code(400).send({ error: "replyToUrl must be a valid x.com or twitter.com post URL" });
    }
    const input = createDraftRequestSchema.parse(request.body);
    const repository = await deps.repository;

    const result = await repository.createDraft({
      accountId: input.accountId,
      sourceInput: input.idea,
      ...(replyTo ? { replyTo } : {}),
      metadata: {
        yolo: input.yolo,
        autopost: input.autopost,
        count: input.count ?? 3,
        tweetType: replyTo ? "reply" : input.tweetType
      }
    });

    return reply.code(201).send(result);
  });

  app.get("/drafts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    const draft = await repository.getDraft(id);

    if (!draft) {
      return reply.code(404).send({ error: "Draft not found" });
    }

    return draft;
  });

  app.post("/drafts/:id/select", async (request) => {
    const { id } = request.params as { id: string };
    const input = selectDraftCandidateRequestSchema.parse(request.body);
    const repository = await deps.repository;

    return repository.selectCandidate({
      draftId: id,
      candidateId: input.candidateId,
      ...(input.editedText ? { editedText: tracePostProcessTweetText("edit-draft", input.editedText) } : {})
    });
  });

  app.post("/drafts/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = approveDraftRequestSchema.parse(request.body);
    if (input.mode === "scheduled" && !input.scheduledFor) {
      return reply.code(400).send({ error: "scheduledFor is required for scheduled jobs" });
    }
    const repository = await deps.repository;
    const existing = await repository.getDraft(id);
    if (!existing) {
      return reply.code(404).send({ error: "Draft not found" });
    }

    const result = await repository.approveDraft({
      draftId: id,
      editedText: tracePostProcessTweetText("update-draft", input.editedText),
      ...(input.mode ? { mode: input.mode } : {}),
      scheduledFor: input.scheduledFor ?? null,
      ...(existing.draft.replyTo ? { replyTo: existing.draft.replyTo } : {})
    });

    return reply.code(201).send(result);
  });
}
