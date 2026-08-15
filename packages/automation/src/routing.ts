import type { SourceItem } from "@zyquor/adapters";
import type { TweetType } from "@zyquor/core";
import { inferTweetTypeFromText } from "./context.js";
import { isTweetType } from "./selection.js";

export interface TweetTypeRouteInput {
  item: SourceItem;
  sourceName?: string;
  sourceType?: string;
}

export interface RecentPostType {
  accountId: string;
  postUrl: string | null;
  postedAt: string;
  postedText?: string | null;
  tweetType?: string | null;
}

export interface TweetTypeRouteOptions {
  accountId?: string;
  now?: Date;
  recentPosts?: RecentPostType[];
}

const ROLLING_TYPE_WINDOW = 10;
const DAILY_TYPE_CAP = 3;
const CONSECUTIVE_TYPE_PENALTY = 0.4;

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

function distinctRecentPosts(posts: RecentPostType[], accountId: string, now: Date) {
  const seen = new Set<string>();
  const distinct: RecentPostType[] = [];
  for (const post of posts) {
    if (post.accountId !== accountId) continue;
    if (typeof post.tweetType !== "string" || !isTweetType(post.tweetType)) continue;
    if (typeof post.postedText === "string" && /^https?:\/\/\S+$/.test(post.postedText.trim())) continue;
    const key = post.postUrl || `${post.postedAt}-${post.tweetType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(post);
  }
  const recentTypes = distinct.slice(-ROLLING_TYPE_WINDOW).map((post) => post.tweetType as TweetType);
  const today = now.toISOString().slice(0, 10);
  const todayCounts = new Map<TweetType, number>();
  for (const post of distinct) {
    if (!post.postedAt.startsWith(today)) continue;
    const type = post.tweetType as TweetType;
    todayCounts.set(type, (todayCounts.get(type) ?? 0) + 1);
  }
  return { recentTypes, todayCounts };
}

function tweetTypeFromMix(
  item: SourceItem,
  mix: Record<string, number>,
  recentTypes: TweetType[],
  todayCounts: Map<TweetType, number>
) {
  const inferred = inferTweetTypeFromText(item);
  const entries = Object.entries(mix)
    .filter(
      (entry): entry is [TweetType, number] =>
        isTweetType(entry[0]) &&
        Number.isFinite(entry[1]) &&
        entry[1] > 0 &&
        (entry[0] !== "narrative_history" || inferred === "narrative_history")
    )
    .map(([type, weight]) => {
      let adjusted = weight;
      if ((todayCounts.get(type) ?? 0) >= DAILY_TYPE_CAP) {
        adjusted = 0;
      }
      const recentCount = recentTypes.reduce((sum, type_) => sum + (type_ === type ? 1 : 0), 0);
      if (recentCount >= ROLLING_TYPE_WINDOW) {
        adjusted = 0;
      } else {
        adjusted *= 1 - recentCount / ROLLING_TYPE_WINDOW;
      }
      if (recentTypes[recentTypes.length - 1] === type) {
        adjusted *= CONSECUTIVE_TYPE_PENALTY;
      }
      return [type, adjusted] as [TweetType, number];
    });
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return inferred;

  let selected = stableHash(`${item.url}\n${item.title}`) % total;
  for (const [type, weight] of entries) {
    selected -= weight;
    if (selected < 0) return type;
  }
  return inferred;
}

export function routeTweetType(
  input: TweetTypeRouteInput,
  configMix: Record<string, number>,
  options: TweetTypeRouteOptions = {}
): TweetType {
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
  if (sourceType === "x-feed") {
    return "feed_observation";
  }
  const { recentTypes, todayCounts } = distinctRecentPosts(
    options.recentPosts ?? [],
    options.accountId ?? "",
    options.now ?? new Date()
  );
  return tweetTypeFromMix(input.item, configMix, recentTypes, todayCounts);
}