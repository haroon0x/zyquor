import type { SourceItem } from "@zyquor/adapters";
import type { TweetType } from "@zyquor/core";
import { inferTweetTypeFromText } from "./context.js";
import { isTweetType } from "./selection.js";

export interface TweetTypeRouteInput {
  item: SourceItem;
  sourceName?: string;
  sourceType?: string;
}

function itemIdentity(item: SourceItem) {
  return item as SourceItem & { source?: unknown; sourceType?: unknown };
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tweetTypeFromMix(item: SourceItem, mix: Record<string, number>) {
  const entries = Object.entries(mix).filter(
    (entry): entry is [TweetType, number] => isTweetType(entry[0]) && Number.isFinite(entry[1]) && entry[1] > 0
  );
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return inferTweetTypeFromText(item);

  let selected = stableHash(`${item.url}\n${item.title}`) % total;
  for (const [type, weight] of entries) {
    selected -= weight;
    if (selected < 0) return type;
  }
  return inferTweetTypeFromText(item);
}

export function routeTweetType(input: TweetTypeRouteInput, configMix: Record<string, number>): TweetType {
  const identity = itemIdentity(input.item);
  const sourceName =
    (typeof identity.source === "string" && identity.source) ||
    (typeof input.item.metadata?.source === "string" && input.item.metadata.source) ||
    input.sourceName ||
    "";
  const sourceType = (typeof identity.sourceType === "string" && identity.sourceType) || input.sourceType || "";
  const metadataType = typeof input.item.metadata?.type === "string" ? input.item.metadata.type : "";

  if (sourceType === "job" || metadataType === "hiring" || sourceName === "hiring" || sourceName === "hackernews-jobs") {
    return "hiring";
  }
  if (sourceType === "feed" || sourceName === "rss" || sourceName === "company-rss" || sourceName === "techcrunch") {
    return "article_summary";
  }
  return tweetTypeFromMix(input.item, configMix);
}
