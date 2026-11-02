import {
  passesTweetQualityFloor,
  formatTweetText,
  postProcessTweetText,
  qualityMinimum,
  scoreTweetQuality,
  type DraftGenerationProvider,
  type GeneratedDraftCandidate
} from "@zyquor/generation";
import type { ZyquorRepository } from "@zyquor/storage";
import type { Draft, DraftCandidate, PostJob, SourcePacket } from "@zyquor/core";
import { accountGenerationContext, articleTweetIdea, hasEnoughSourceContext, sourceTweetInput } from "./context.js";
import { validateSourcePostQuality, withRequiredSourceUrl } from "./quality.js";
import { normalizeTweetType } from "./selection.js";
import { hasTopicOverlap } from "./topic.js";

const DRAFT_TOPIC_DEDUPE_DAYS = 7;

export class TopicDraftExistsError extends Error {
  constructor(readonly topicTitle: string, readonly existingTitle: string, readonly accountId: string) {
    super(`Draft already exists for this topic (${topicTitle})`);
    this.name = "TopicDraftExistsError";
  }
}

async function assertSingleDraftPerTopic(input: {
  accountId: string;
  packetId: string;
  repository: ZyquorRepository;
  title: string;
  now?: Date | null;
}) {
  const cutoff = new Date((input.now ?? new Date()).getTime() - DRAFT_TOPIC_DEDUPE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const [drafts, packets] = await Promise.all([
    input.repository.listDrafts(input.accountId),
    input.repository.listSourcePackets(input.accountId)
  ]);
  const titleByPacketId = new Map(packets.map((packet) => [packet.id, packet.title]));
  for (const draft of drafts) {
    if (draft.status === "archived" || draft.createdAt < cutoff) continue;
    const sourcePacketId = draft.metadata?.sourcePacketId;
    if (typeof sourcePacketId !== "string" || sourcePacketId === input.packetId) continue;
    const existingTitle = titleByPacketId.get(sourcePacketId);
    if (typeof existingTitle === "string" && hasTopicOverlap(input.title, [existingTitle])) {
      throw new TopicDraftExistsError(input.title, existingTitle, input.accountId);
    }
  }
}

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
  if (!hasEnoughSourceContext(input.packet)) {
    return [];
  }
  const context = await accountGenerationContext(input.repository, input.packet.accountId);
  const tweetInput = sourceTweetInput(input.packet);

  const candidates = await input.generationProvider.generateDraftCandidates({
    idea: input.packet.title,
    ...(tweetInput.source ? { context: tweetInput.source } : {}),
    count: input.count ?? 1,
    preserveCase: true,
    ...context,
    ...(input.packet.feedback ? { feedback: input.packet.feedback } : {}),
    tweetType: normalizeTweetType(input.packet.tweetType)
  });

  if (input.packet.sourceType === "x-feed") {
    const qualityMin = qualityMinimum();
    const passing = candidates.filter((candidate) =>
      passesTweetQualityFloor(formatTweetText(candidate.text), qualityMin)
    );
    if (passing.length === 0) {
      throw new Error(`${input.generationProvider.name} returned no draft candidates`);
    }
    return passing;
  }

  return candidates;
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
  await assertSingleDraftPerTopic({
    accountId: input.packet.accountId,
    packetId: input.packet.id,
    repository: input.repository,
    title: input.packet.title,
    now: input.packet.createdAt ? new Date(input.packet.createdAt) : null
  });
  let candidates: GeneratedDraftCandidate[] = await generateCandidatesForPacket({
    ...candidateInput
  }).then((items) =>
    items.map((candidate) => {
      const formatter = candidate.score.provider === input.generationProvider.name ? formatTweetText : postProcessTweetText;
      const normalized = withRequiredSourceUrl(formatter(candidate.text), input.packet);
      return {
        ...candidate,
        text: normalized,
        score: {
          ...candidate.score,
          quality: scoreTweetQuality(normalized)
        }
      };
    })
  );
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
        .filter((candidate) => candidate.validation.ok && candidate.generatedValidation)
        .sort((a, b) => Number(b.score.quality) - Number(a.score.quality) || Number((a.score as Record<string, unknown>).rank) - Number((b.score as Record<string, unknown>).rank))
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
              reason:
                candidates.length === 0
                  ? "no_candidates_generated"
                  : passingCandidates.length === 0
                    ? "all_below_quality_floor"
                    : null,
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
