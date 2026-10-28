import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import {
  approveDraftRequestSchema,
  createDraftRequestSchema,
  selectDraftCandidateRequestSchema,
  AI_SLOP_PHRASES,
  parseReplyTargetUrl
} from "@zyquor/core";
import {
  accountGenerationContext,
  draftFromSourcePacket,
  hasEnoughSourceContext,
  normalizeTweetType,
  packetFieldsFromItem,
  sourceTweetInput,
  validateGeneratedPostQuality,
  validateSourcePostQuality,
  withRequiredSourceUrl,
  analyzePostFeatures
} from "@zyquor/automation";
import {
  isCleanTweetText,
  passesTweetQualityFloor,
  qualityMinimum,
  replyQualityMinimum,
  scoreTweetQuality
} from "@zyquor/generation";
import { HttpError } from "../lib/errors.js";
import { tracePostProcessTweetText } from "../lib/post-process.js";
import { isPostingMode } from "../lib/posting.js";

function generationTweetType(value: string) {
  return value === "hiring" ? value : normalizeTweetType(value);
}

export function registerDraftsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/drafts/pending", async () => {
    const repository = await deps.repository;
    const drafts = await repository.listPendingDrafts();
    return {
      drafts: drafts.filter((draft) => draft.metadata.yolo === true || draft.metadata.lane === "batch")
    };
  });

  app.get("/drafts/quality-gate-failures", async () => {
    const repository = await deps.repository;
    const drafts = await repository.listQualityGateFailedDrafts();
    return {
      drafts: drafts.map(({ draft, candidates }) => ({
        draft,
        candidates,
        qualityGate: draft.metadata.qualityGate
      }))
    };
  });

  app.post("/drafts/:id/evaluate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    const existing = await repository.getDraft(id);
    if (!existing) {
      return reply.code(404).send({ error: "Draft not found" });
    }

    const candidates = [];
    for (const candidate of existing.candidates) {
      candidates.push(await repository.updateCandidateScore(candidate.id, {
        ...candidate.score,
        quality: scoreTweetQuality(candidate.text)
      }));
    }

    return { draft: existing.draft, candidates };
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
    const sourcePacketId = typeof metadata.sourcePacketId === "string" ? metadata.sourcePacketId : null;
    const sourcePacket = sourcePacketId ? await repository.getSourcePacket(sourcePacketId) : null;
    const sourceContext = sourcePacket ? sourceTweetInput(sourcePacket) : null;
    const count = metadata.yolo ? 1 : (Number(metadata.count) || 1);

    const candidates = await deps.generationProvider.generateDraftCandidates({
      idea: sourceContext ? "" : draft.sourceInput,
      ...(sourceContext?.source ? { context: sourceContext.source } : {}),
      count,
      preserveCase: true,
      ...context,
      ...(draft.replyTo
        ? { tweetType: "reply" }
        : metadata.tweetType
          ? { tweetType: generationTweetType(metadata.tweetType as string) }
          : {}),
      ...(draft.replyTo
        ? {
            replyContext: {
              authorHandle: draft.replyTo.authorHandle,
              url: draft.replyTo.url,
              ...(draft.replyTo.authorName ? { authorName: draft.replyTo.authorName } : {}),
              ...(draft.replyTo.text ? { text: draft.replyTo.text } : {})
            }
          }
        : {}),
      ...(sourcePacket?.feedback ? { feedback: sourcePacket.feedback } : {})
    });

    let updated = await repository.saveDraftCandidates(
      draft.id,
      candidates.map((candidate) => {
        const preserveCase = candidate.score.provider === deps.generationProvider.name;
        const normalizedText = tracePostProcessTweetText("select-candidate", candidate.text, preserveCase);
        const text = sourcePacket ? withRequiredSourceUrl(normalizedText, sourcePacket) : normalizedText;
        return {
          ...candidate,
          text,
          score: {
            ...candidate.score,
            quality: scoreTweetQuality(text)
          }
        };
      })
    );

    const qualityMin = qualityMinimum();
    if (metadata.yolo) {
      const sortedCandidates = [...updated.candidates].sort(
        (a, b) =>
          Number(b.score.quality ?? -Infinity) - Number(a.score.quality ?? -Infinity) ||
          Number(a.score.rank ?? Infinity) - Number(b.score.rank ?? Infinity)
      );
      const topCandidate = sortedCandidates[0];
      const bestCandidate = sortedCandidates.find((candidate) => passesTweetQualityFloor(candidate.text, qualityMin));
      const bestQuality = Number(topCandidate?.score.quality ?? -Infinity);
      const slopPhrase = topCandidate
        ? AI_SLOP_PHRASES.find((phrase) => topCandidate.text.toLowerCase().includes(phrase)) ?? null
        : null;
      if (!bestCandidate || slopPhrase) {
        const reason = slopPhrase ? "ai_slop_phrase_detected" : "all_below_quality_floor";
        await repository.updateDraftMetadata(draft.id, {
          ...metadata,
          qualityGate: {
            bestQuality: Number.isFinite(bestQuality) ? bestQuality : null,
            bestCandidateId: topCandidate?.id ?? null,
            threshold: qualityMin,
            slopPhrase,
            rejectedAt: new Date().toISOString(),
            reason
          }
        });
        return reply.code(201).send({
          draft: (await repository.getDraft(draft.id))?.draft,
          candidates: updated.candidates,
          reason,
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
          editedText: tracePostProcessTweetText(
            "manual-select",
            selectedText,
            bestCandidate.score.provider === deps.generationProvider.name
          ),
          mode,
          ...(draft.replyTo ? { replyTo: draft.replyTo } : {}),
          scheduledFor: (metadata.scheduleStart as string | null | undefined) ?? null
        });
        return reply.code(201).send({ ...approved, candidates: updated.candidates });
      }
    }

    return reply.code(201).send(updated);
  });

  app.post("/drafts/research", async (request, reply) => {
    const input = createDraftRequestSchema.parse(request.body);
    if (input.replyToUrl) {
      return reply.code(400).send({ error: "Research drafts do not support reply targets" });
    }
    const adapter = deps.sourceAdapters.get("news");
    if (!adapter) {
      throw new HttpError(503, "Topic search is unavailable");
    }

    const now = new Date();
    const maxAgeMs = 48 * 60 * 60 * 1000;
    const items = (await adapter.fetch({ maxItems: 30, topic: input.idea }))
      .filter((item) => {
        const raw = item.metadata?.published ?? item.metadata?.pubDate;
        if (typeof raw !== "string") return false;
        const publishedAt = Date.parse(raw);
        if (!Number.isFinite(publishedAt)) return false;
        const age = now.getTime() - publishedAt;
        return age >= -5 * 60 * 1000 && age <= maxAgeMs;
      })
      .sort((a, b) => Date.parse(String(b.metadata?.published ?? b.metadata?.pubDate)) - Date.parse(String(a.metadata?.published ?? a.metadata?.pubDate)));
    const repository = await deps.repository;

    for (const item of items) {
      if (item.url && (await repository.hasPostHistorySourceUrl(input.accountId, item.url))) continue;
      if (item.url && (await repository.getSourcePacketByUrl(item.url, input.accountId))) continue;
      const fields = packetFieldsFromItem(item);
      if (!hasEnoughSourceContext(fields)) continue;

      const packet = await repository.createSourcePacket({
        accountId: input.accountId,
        facts: fields.facts,
        sourceType: "news",
        summary: fields.summary,
        title: fields.title,
        tweetType: input.tweetType ?? "useful_info",
        url: item.url
      });

      try {
        const drafted = await draftFromSourcePacket({
          generationProvider: deps.generationProvider,
          packet,
          repository,
          options: {
            ...(input.yolo ? { autoApprove: true } : {}),
            count: input.count ?? 1,
            ...(input.yolo
              ? {
                  mode: input.autopost ? "autopost" : "prepare_only"
                }
              : {})
          }
        });
        return reply.code(201).send(drafted);
      } catch (error) {
        await repository.deleteSourcePacket(packet.id).catch(() => null);
        throw error;
      }
    }

    throw new HttpError(404, "No unused source from the last 48 hours matched this topic");
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
        count: input.count ?? 1,
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

  app.delete("/drafts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    const draft = await repository.getDraft(id);
    if (!draft) {
      return reply.code(404).send({ error: "Draft not found" });
    }

    return { draft: await repository.deleteDraft(id) };
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

    const selectedCandidate = existing.candidates.find((candidate) => candidate.selected);
    const preserveCase = selectedCandidate?.score.provider === deps.generationProvider.name;
    let approvedText = tracePostProcessTweetText("update-draft", input.editedText, preserveCase);
    // Server-side approval screen for agent-initiated approvals. When the
    // caller passes screened=true the route enforces the deterministic quality
    // floor, text cleanliness, and the tweet length limit here, so no agent
    // can approve text that fails them. Agents must always send screened
    // true; humans may omit it entirely.
    if (input.screened === true) {
      const screenReasons: string[] = [];
      // Replies use their own floor: the post floor assumes long-form density
      // that one-line replies legitimately do not carry. Same scorer, same
      // cleanliness checks, different minimum.
      const isReply = existing.draft.metadata.tweetType === "reply";
      const screenFloor = isReply ? replyQualityMinimum() : qualityMinimum();
      if (approvedText.length > 279) {
        screenReasons.push(`too_long (${approvedText.length} chars > 279)`);
      }
      if (!isCleanTweetText(approvedText)) {
        screenReasons.push("unclean text (links, spam markers, or slop phrases)");
      }
      if (!passesTweetQualityFloor(approvedText, screenFloor)) {
        screenReasons.push(`quality ${scoreTweetQuality(approvedText)} below floor ${screenFloor}`);
      }
      if (screenReasons.length > 0) {
        return reply.code(409).send({
          error: `Approval screen failed: ${screenReasons.join("; ")}`,
          screenFailed: screenReasons
        });
      }
    }
    if (input.mode === "autopost") {
      const sourcePacketId = typeof existing.draft.metadata.sourcePacketId === "string"
        ? existing.draft.metadata.sourcePacketId
        : null;
      const sourcePacket = sourcePacketId ? await repository.getSourcePacket(sourcePacketId) : null;
      const sourceQuality = sourcePacket
        ? validateSourcePostQuality({
            history: await repository.listPostHistory(),
            packet: sourcePacket,
            text: approvedText
          })
        : null;
      const qualityText = sourceQuality?.text ?? approvedText;
      const generatedQualityRequired =
        existing.draft.metadata.yolo === true || existing.draft.metadata.generatedScore !== undefined;
      const generatedQuality = generatedQualityRequired ? validateGeneratedPostQuality(qualityText) : null;
      const reasons = [
        ...(sourceQuality?.reasons ?? []),
        ...(generatedQuality?.reasons ?? [])
      ];
      // Score floor for unedited generated text: the deterministic quality
      // score already exists per candidate, but only the yolo path enforced
      // it. Shipping a self-scored sub-floor post on autopost defeats the
      // point of the floor. Operator edits are trusted as-is — the operator
      // is the authority on their own voice.
      const qualityMin = qualityMinimum();
      const selectedScore = selectedCandidate ? Number(selectedCandidate.score.quality ?? NaN) : NaN;
      const operatorEdited = selectedCandidate
        ? approvedText.trim() !== selectedCandidate.text.trim()
        : true;
      if (Number.isFinite(selectedScore) && selectedScore < qualityMin && !operatorEdited) {
        reasons.push(`generated_score_below_floor (${selectedScore} < ${qualityMin}); edit the text or regenerate`);
      }
      if (reasons.length > 0) {
        return reply.code(409).send({ error: `Autopost quality gate failed: ${[...new Set(reasons)].join(", ")}` });
      }
      approvedText = qualityText;
    }

    // Attribution memory: freeze the content features at approval so later
    // performance analysis can compare features against outcomes.
    await repository.updateDraftMetadata(id, {
      ...existing.draft.metadata,
      features: analyzePostFeatures(approvedText)
    });

    const result = await repository.approveDraft({
      draftId: id,
      editedText: approvedText,
      ...(input.mode ? { mode: input.mode } : {}),
      scheduledFor: input.scheduledFor ?? null,
      ...(existing.draft.replyTo ? { replyTo: existing.draft.replyTo } : {})
    });

    return reply.code(201).send(result);
  });
}
