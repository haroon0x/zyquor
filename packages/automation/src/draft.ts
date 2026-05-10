import { postProcessTweetText, type DraftGenerationProvider, type GeneratedDraftCandidate } from "@zyquor/generation";
import type { ZyquorRepository } from "@zyquor/storage";
import type { Draft, DraftCandidate, PostJob, SourcePacket } from "@zyquor/core";
import { accountGenerationContext, articleTweetIdea, sourceTweetInput } from "./context.js";
import { validateSourcePostQuality } from "./quality.js";

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
      text: postProcessTweetText(candidate.text)
    }))
  );
  const firstCandidate = candidates[0] ?? null;
  const history = input.options?.autoApprove ? await input.repository.listPostHistory() : [];
  const approvedCandidate =
    firstCandidate && input.options?.autoApprove
      ? validateSourcePostQuality({
          history,
          packet: input.packet,
          text: firstCandidate.text
        })
      : null;
  const sourceMetadata = {
    ...(input.options?.mediaUrls?.length ? { mediaUrls: input.options.mediaUrls } : {}),
    sourcePacketId: input.packet.id,
    sourceType: input.packet.sourceType,
    tweetType: input.packet.tweetType
  };

  if (input.options?.autoApprove && firstCandidate) {
    if (!approvedCandidate?.ok) {
      throw new Error(`Source post failed quality gate: ${approvedCandidate?.reasons.join(", ") || "unknown"}`);
    }
    const draft = await input.repository.createDraft({
      accountId: input.packet.accountId,
      sourceInput: articleTweetIdea(input.packet),
      metadata: {
        ...sourceMetadata,
        generatedScore: firstCandidate.score
      }
    });
    const packet = await input.repository.markSourcePacketDrafted(input.packet.id);
    const approved = await input.repository.approveDraft({
      draftId: draft.draft.id,
      editedText: approvedCandidate.text,
      mode: input.options.mode ?? "autopost"
    });

    return { ...draft, packet, approved };
  }

  const draft = await input.repository.createDraft({
    accountId: input.packet.accountId,
    sourceInput: articleTweetIdea(input.packet),
    metadata: sourceMetadata,
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
  const packet = await input.repository.markSourcePacketDrafted(input.packet.id);

  if (!input.options?.autoApprove) {
    return { ...draft, approved: null, packet };
  }

  const selectedText = draft.candidates[0]?.text;
  if (!selectedText) {
    return { ...draft, approved: null, packet };
  }

  const approved = await input.repository.approveDraft({
    draftId: draft.draft.id,
    editedText: selectedText,
    mode: input.options.mode ?? "autopost"
  });

  return { ...draft, packet, approved };
}
