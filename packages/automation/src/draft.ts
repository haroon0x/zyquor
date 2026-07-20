import { postProcessTweetText, type DraftGenerationProvider, type GeneratedDraftCandidate } from "@zyquor/generation";
import type { ZyquorRepository } from "@zyquor/storage";
import type { Draft, DraftCandidate, PostJob, SourcePacket } from "@zyquor/core";
import { accountGenerationContext, articleTweetIdea, sourceTweetInput } from "./context.js";
import { validateSourcePostQuality, withRequiredSourceUrl } from "./quality.js";

export interface PacketDraftOptions {
  autoApprove?: boolean;
  count?: number;
  mediaUrls?: string[];
  mode?: PostJob["mode"];
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
  const context = await accountGenerationContext(input.repository, input.packet.accountId);
  const tweetInput = sourceTweetInput(input.packet);

  return input.generationProvider.generateDraftCandidates({
    idea: tweetInput.idea,
    ...(tweetInput.source ? { context: tweetInput.source } : {}),
    count: input.count ?? 3,
    ...context,
    tweetType: input.packet.tweetType
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
  const candidates = await generateCandidatesForPacket({
    ...candidateInput
  }).then((items) =>
    items.map((candidate) => ({
      ...candidate,
      text: withRequiredSourceUrl(postProcessTweetText(candidate.text), input.packet)
    }))
  );
  const history = input.options?.autoApprove ? await input.repository.listPostHistory() : [];
  const qualityMin = Number(process.env.ZYQUOR_QUALITY_MIN ?? 3);
  const passingCandidates = input.options?.autoApprove
    ? candidates
        .map((candidate) => ({
          ...candidate,
          validation: validateSourcePostQuality({
            history,
            packet: input.packet,
            text: candidate.text
          })
        }))
        .filter((candidate) => candidate.validation.ok && Number(candidate.score.quality) >= qualityMin)
        .sort((a, b) => Number(b.score.quality) - Number(a.score.quality))
    : [];
  const approvedCandidate = passingCandidates[0] ?? null;
  const sourceMetadata = {
    ...(input.options?.mediaUrls?.length ? { mediaUrls: input.options.mediaUrls } : {}),
    sourcePacketId: input.packet.id,
    sourceType: input.packet.sourceType,
    tweetType: input.packet.tweetType
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
              reason: candidates.length === 0 ? "no_candidates_generated" : passingCandidates.length === 0 ? "all_below_quality_floor" : null,
              candidates: candidates.map((candidate) => ({
                text: candidate.text,
                score: candidate.score,
                passedQualityMin: Number(candidate.score.quality) >= qualityMin,
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
        tweetType: input.packet.tweetType
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
