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
  articleTweetIdea,
  draftFromSourcePacket,
  hasEnoughSourceContext,
  normalizeTweetType,
  packetFieldsFromItem,
  sourceTweetInput,
  validateGeneratedPostQuality,
  validateSourcePostQuality
} from "@zyquor/automation";
import { passesTweetQualityFloor, qualityMinimum, scoreTweetQuality } from "@zyquor/generation";
import { asError, HttpError } from "../lib/errors.js";
import { tracePostProcessTweetText } from "../lib/post-process.js";
import { isPostingMode } from "../lib/posting.js";
import { qualityJudgeOptions } from "../lib/quality-judge.js";

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

    const metadata = existing.draft.metadata as Record<string, unknown>;
    const sourcePacketId = typeof metadata.sourcePacketId === "string" ? metadata.sourcePacketId : null;
    const sourcePacket = sourcePacketId ? await repository.getSourcePacket(sourcePacketId) : null;
    const judgeIdea = sourcePacket ? articleTweetIdea(sourcePacket) : existing.draft.sourceInput;
    const judgeTweetType = existing.draft.replyTo
      ? "reply"
      : typeof metadata.tweetType === "string"
        ? generationTweetType(metadata.tweetType)
        : undefined;
    const judgeOptions = qualityJudgeOptions(deps.generationEnv);
    const evaluations = [];

    try {
      for (const candidate of existing.candidates) {
        evaluations.push(await deps.tweetQualityEvaluator(
          {
            text: candidate.text,
            idea: judgeIdea,
            ...(judgeTweetType ? { tweetType: judgeTweetType } : {})
          },
          judgeOptions
        ));
      }
    } catch (error) {
      throw new HttpError(503, `Local Ollama quality judge failed: ${asError(error).message}`);
    }

    const judgedAt = new Date().toISOString();
    const candidates = [];
    for (const [index, candidate] of existing.candidates.entries()) {
      const evaluation = evaluations[index]!;
      candidates.push(await repository.updateCandidateScore(candidate.id, {
        ...candidate.score,
        judgePass: evaluation.pass,
        judgeSpecific: evaluation.specific,
        judgeGrounded: evaluation.grounded,
        judgePayoff: evaluation.payoff,
        judgeStyleFit: evaluation.styleFit,
        judgeScore: evaluation.score,
        judgeVerdict: evaluation.verdict,
        judgeReasons: evaluation.reasons,
        judgedAt,
        judgeModel: judgeOptions.model
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
    const judgeIdea = sourcePacket ? articleTweetIdea(sourcePacket) : draft.sourceInput;
    const judgeTweetType = draft.replyTo
      ? "reply"
      : typeof metadata.tweetType === "string"
        ? generationTweetType(metadata.tweetType)
        : undefined;
    const count = metadata.yolo ? 1 : (Number(metadata.count) || 3);

    const candidates = await deps.generationProvider.generateDraftCandidates({
      idea: sourceContext ? "" : draft.sourceInput,
      ...(sourceContext?.source ? { context: sourceContext.source } : {}),
      count,
      ...context,
      ...(draft.replyTo
        ? { tweetType: "reply" }
        : metadata.tweetType
          ? { tweetType: generationTweetType(metadata.tweetType as string) }
          : {}),
      ...(draft.replyTo
        ? { replyContext: { authorHandle: draft.replyTo.authorHandle, url: draft.replyTo.url } }
        : {}),
      ...(sourcePacket?.feedback ? { feedback: sourcePacket.feedback } : {})
    });

    let updated = await repository.saveDraftCandidates(
      draft.id,
      candidates.map((candidate) => {
        const text = tracePostProcessTweetText("select-candidate", candidate.text);
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
      const judgeOptions = qualityJudgeOptions(deps.generationEnv);
      const judgedAt = new Date().toISOString();
      try {
        const judgedCandidates: typeof updated.candidates = [];
        for (const candidate of updated.candidates) {
          const evaluation = await deps.tweetQualityEvaluator(
            {
              idea: judgeIdea,
              text: candidate.text,
              ...(judgeTweetType ? { tweetType: judgeTweetType } : {})
            },
            judgeOptions
          );
          judgedCandidates.push(await repository.updateCandidateScore(candidate.id, {
            ...candidate.score,
            judgePass: evaluation.pass,
            judgeSpecific: evaluation.specific,
            judgeGrounded: evaluation.grounded,
            judgePayoff: evaluation.payoff,
            judgeStyleFit: evaluation.styleFit,
            judgeScore: evaluation.score,
            judgeVerdict: evaluation.verdict,
            judgeReasons: evaluation.reasons,
            judgedAt,
            judgeModel: judgeOptions.model
          }));
        }
        updated = { ...updated, candidates: judgedCandidates };
      } catch (error) {
        await repository.updateDraftMetadata(draft.id, {
          ...metadata,
          qualityGate: {
            threshold: qualityMin,
            reason: "quality_judge_unavailable",
            rejectedAt: new Date().toISOString()
          }
        });
        throw new HttpError(503, `Local Ollama quality judge failed: ${asError(error).message}`);
      }

      const sortedCandidates = [...updated.candidates].sort(
        (a, b) =>
          Number(b.score.judgePass === true) - Number(a.score.judgePass === true) ||
          Number(b.score.judgeScore ?? -Infinity) - Number(a.score.judgeScore ?? -Infinity) ||
          Number(b.score.quality ?? -Infinity) - Number(a.score.quality ?? -Infinity) ||
          Number(a.score.rank ?? Infinity) - Number(b.score.rank ?? Infinity)
      );
      const topCandidate = sortedCandidates[0];
      const bestCandidate = sortedCandidates.find(
        (candidate) => candidate.score.judgePass === true && passesTweetQualityFloor(candidate.text, qualityMin)
      );
      const bestQuality = Number(topCandidate?.score.quality ?? -Infinity);
      const judgePassCount = sortedCandidates.filter((candidate) => candidate.score.judgePass === true).length;
      const slopPhrase = topCandidate
        ? AI_SLOP_PHRASES.find((phrase) => topCandidate.text.toLowerCase().includes(phrase)) ?? null
        : null;
      if (!bestCandidate || slopPhrase) {
        const reason = slopPhrase
          ? "ai_slop_phrase_detected"
          : judgePassCount === 0
            ? "quality_judge_rejected_all"
            : "all_below_quality_floor";
        await repository.updateDraftMetadata(draft.id, {
          ...metadata,
          qualityGate: {
            bestQuality: Number.isFinite(bestQuality) ? bestQuality : null,
            bestCandidateId: topCandidate?.id ?? null,
            threshold: qualityMin,
            judgePassCount,
            judgeModel: judgeOptions.model,
            judgeReasons: topCandidate?.score.judgeReasons ?? [],
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
          judgePassCount,
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
    const history = await repository.listPostHistory();

    for (const item of items) {
      if (history.some((post) => post.accountId === input.accountId && post.sourceUrl === item.url)) continue;
      if (await repository.getSourcePacketByUrl(item.url, input.accountId)) continue;
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
            count: input.count ?? 3,
            ...(input.yolo
              ? {
                  mode: input.autopost ? "autopost" : "prepare_only",
                  qualityEvaluator: deps.tweetQualityEvaluator,
                  qualityEvaluatorOptions: qualityJudgeOptions(deps.generationEnv)
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

    let approvedText = tracePostProcessTweetText("update-draft", input.editedText);
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
      if (reasons.length > 0) {
        return reply.code(409).send({ error: `Autopost quality gate failed: ${[...new Set(reasons)].join(", ")}` });
      }
      approvedText = qualityText;
    }

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
