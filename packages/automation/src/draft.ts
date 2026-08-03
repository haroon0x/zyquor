import {
  passesTweetQualityFloor,
  postProcessTweetText,
  qualityMinimum,
  scoreTweetQuality,
  type DraftGenerationProvider,
  type EvaluateTweetQualityOptions,
  type GeneratedDraftCandidate,
  type TweetQualityEvaluator
} from "@zyquor/generation";
import type { ZyquorRepository } from "@zyquor/storage";
import type { Draft, DraftCandidate, PostJob, SourcePacket } from "@zyquor/core";
import { accountGenerationContext, articleTweetIdea, hasEnoughSourceContext, sourceTweetInput } from "./context.js";
import { validateSourcePostQuality, withRequiredSourceUrl } from "./quality.js";
import { normalizeTweetType } from "./selection.js";

export interface PacketDraftOptions {
  autoApprove?: boolean;
  count?: number;
  mediaUrls?: string[];
  mode?: PostJob["mode"];
  qualityEvaluator?: TweetQualityEvaluator;
  qualityEvaluatorOptions?: EvaluateTweetQualityOptions;
}

export interface PacketDraftResult {
  approved: { draft: Draft; job: PostJob } | null;
  candidates: DraftCandidate[];
  draft: Draft;
  packet: SourcePacket;
}

export async function generateCandidatesForPacket(input: {
  generationProvider: DraftGenerationProvider;
  packet: SourcePacket;
  repository: ZyquorRepository;
  count?: number;
}): Promise<GeneratedDraftCandidate[]> {
  if (!hasEnoughSourceContext(input.packet)) {
    throw new Error("Source needs at least one concrete fact beyond the title");
  }
  const context = await accountGenerationContext(input.repository, input.packet.accountId);
  const tweetInput = sourceTweetInput(input.packet);

  return input.generationProvider.generateDraftCandidates({
    idea: "",
    ...(tweetInput.source ? { context: tweetInput.source } : {}),
    insightRequired: true,
    count: input.count ?? 1,
    ...context,
    ...(input.packet.feedback ? { feedback: input.packet.feedback } : {}),
    tweetType: normalizeTweetType(input.packet.tweetType)
  });
}

export async function draftFromSourcePacket(input: {
  generationProvider: DraftGenerationProvider;
  packet: SourcePacket;
  repository: ZyquorRepository;
  options?: PacketDraftOptions;
}): Promise<PacketDraftResult> {
  const candidateInput = {
    generationProvider: input.generationProvider,
    packet: input.packet,
    repository: input.repository,
    ...(input.options?.count !== undefined ? { count: input.options.count } : {})
  };
  let candidates: GeneratedDraftCandidate[] = await generateCandidatesForPacket({
    ...candidateInput
  }).then((items) =>
    items.map((candidate) => ({
      ...candidate,
      text: withRequiredSourceUrl(postProcessTweetText(candidate.text), input.packet),
      score: {
        ...candidate.score,
        quality: scoreTweetQuality(withRequiredSourceUrl(postProcessTweetText(candidate.text), input.packet))
      }
    }))
  );
  let judgeError: string | null = null;
  if (input.options?.autoApprove) {
    if (!input.options.qualityEvaluator) {
      judgeError = "quality_judge_unavailable";
    } else {
      const judgeIdea = articleTweetIdea(input.packet);
      const judgeTweetType = normalizeTweetType(input.packet.tweetType);
      const judgedAt = new Date().toISOString();
      try {
        const judgedCandidates: GeneratedDraftCandidate[] = [];
        for (const candidate of candidates) {
          const evaluation = await input.options.qualityEvaluator(
            {
              idea: judgeIdea,
              text: candidate.text,
              tweetType: judgeTweetType
            },
            input.options.qualityEvaluatorOptions
          );
          judgedCandidates.push({
            ...candidate,
            score: {
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
              ...(input.options.qualityEvaluatorOptions?.model
                ? { judgeModel: input.options.qualityEvaluatorOptions.model }
                : {})
            }
          });
        }
        candidates = judgedCandidates;
      } catch {
        judgeError = "quality_judge_unavailable";
      }
    }
  }
  const history = input.options?.autoApprove ? await input.repository.listPostHistory() : [];
  const qualityMin = qualityMinimum();
  const passingCandidates = input.options?.autoApprove
    ? candidates
        .map((candidate) => ({
          ...candidate,
          validation: validateSourcePostQuality({
            history,
            packet: input.packet,
            text: candidate.text
          }),
          generatedValidation: passesTweetQualityFloor(candidate.text, qualityMin)
        }))
        .filter((candidate) => candidate.validation.ok && candidate.generatedValidation && candidate.score.judgePass === true)
        .sort((a, b) => Number(b.score.quality) - Number(a.score.quality) || Number((a.score as Record<string, unknown>).rank) - Number((b.score as Record<string, unknown>).rank))
    : [];
  const approvedCandidate = passingCandidates[0] ?? null;
  const sourceMetadata = {
    ...(input.options?.mediaUrls?.length ? { mediaUrls: input.options.mediaUrls } : {}),
    sourcePacketId: input.packet.id,
    sourceType: input.packet.sourceType,
    tweetType: normalizeTweetType(input.packet.tweetType)
  };

  if (input.options?.autoApprove && approvedCandidate) {
    const draft = await input.repository.createDraft({
      accountId: input.packet.accountId,
      sourceInput: articleTweetIdea(input.packet),
      metadata: {
        ...sourceMetadata,
        generatedScore: approvedCandidate.score
      }
    });
    try {
      const packet = await input.repository.markSourcePacketDrafted(input.packet.id);
      const approved = await input.repository.approveDraft({
        draftId: draft.draft.id,
        editedText: approvedCandidate.validation.text,
        mode: input.options.mode ?? "autopost"
      });

      return { ...draft, packet, approved };
    } catch (error) {
      await input.repository.deleteDraft(draft.draft.id).catch(() => null);
      await input.repository.resetSourcePacket(input.packet.id).catch(() => null);
      throw error;
    }
  }

  const draft = await input.repository.createDraft({
    accountId: input.packet.accountId,
    sourceInput: articleTweetIdea(input.packet),
    metadata: {
      ...sourceMetadata,
      ...(input.options?.autoApprove
        ? {
            qualityGate: {
              threshold: qualityMin,
              reason:
                candidates.length === 0
                  ? "no_candidates_generated"
                  : judgeError ?? (passingCandidates.length === 0 ? "quality_judge_rejected_all" : null),
              candidates: candidates.map((candidate) => ({
                text: candidate.text,
                score: candidate.score,
                passedQualityMin: passesTweetQualityFloor(candidate.text, qualityMin),
                reasons: validateSourcePostQuality({ history, packet: input.packet, text: candidate.text }).reasons
              }))
            }
          }
        : {})
    },
    candidates: candidates.map((candidate) => ({
      text: candidate.text,
      score: {
        ...candidate.score,
        sourcePacketId: input.packet.id,
        sourceType: input.packet.sourceType,
        tweetType: normalizeTweetType(input.packet.tweetType)
      }
    }))
  });
  try {
    const packet = await input.repository.markSourcePacketDrafted(input.packet.id);
    return { ...draft, approved: null, packet };
  } catch (error) {
    await input.repository.deleteDraft(draft.draft.id).catch(() => null);
    throw error;
  }
}
