import type { SourceType, TweetType } from "@zyquor/core";
import { ALL_TWEET_TYPES, SOURCE_TYPES } from "@zyquor/core";
import type { ZyquorRepository } from "@zyquor/storage";
import { sourcePacketIdForDraft } from "./source-packet.js";

function metadataSourceType(value: unknown): SourceType | null {
  return typeof value === "string" && SOURCE_TYPES.includes(value as SourceType) ? (value as SourceType) : null;
}

function metadataTweetType(value: unknown): TweetType | null {
  return typeof value === "string" && ALL_TWEET_TYPES.includes(value as TweetType) ? (value as TweetType) : null;
}

export async function postHistorySnapshot(repository: ZyquorRepository, draftId: string) {
  const draft = await repository.getDraft(draftId);
  const sourcePacketId = draft ? await sourcePacketIdForDraft(repository, draftId) : null;
  const packet = sourcePacketId ? await repository.getSourcePacket(sourcePacketId) : null;
  const metadata = draft?.draft.metadata ?? {};

  return {
    metadata: {
      draftMetadata: metadata,
      ...(packet
        ? {
            sourceFacts: packet.facts,
            sourceSummary: packet.summary
          }
        : {})
    },
    sourcePacketId,
    sourceTitle: packet?.title ?? (typeof metadata.sourceTitle === "string" ? metadata.sourceTitle : null),
    sourceType: packet?.sourceType ?? metadataSourceType(metadata.sourceType),
    sourceUrl: packet?.url ?? (typeof metadata.sourceUrl === "string" ? metadata.sourceUrl : null),
    tweetType: packet?.tweetType ?? metadataTweetType(metadata.tweetType)
  };
}
