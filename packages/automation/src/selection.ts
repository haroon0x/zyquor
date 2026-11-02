import { ALL_TWEET_TYPES, SOURCE_TYPES, type SourceType, type TweetType } from "@zyquor/core";

export function isSourceType(value: string): value is SourceType {
  return (SOURCE_TYPES as readonly string[]).includes(value);
}

export function isTweetType(value: string): value is TweetType {
  return (ALL_TWEET_TYPES as readonly string[]).includes(value);
}

export function normalizeTweetType(value: string | undefined, fallback: TweetType = "useful_info"): TweetType {
  if (!value) return fallback;
  return isTweetType(value) ? value : fallback;
}

export function pickTweetType(mix: Record<string, number>, fallback: TweetType = "useful_info"): TweetType {
  const total = Object.values(mix).reduce((sum, value) => (typeof value === "number" ? sum + value : sum), 0);
  if (total <= 0) return fallback;

  let random = Math.floor(Math.random() * total);
  for (const [type, weight] of Object.entries(mix)) {
    if (typeof weight !== "number" || !isTweetType(type)) continue;
    random -= weight;
    if (random < 0) return normalizeTweetType(type, fallback);
  }

  return fallback;
}

export function isWithinScheduleWindow(start: string, end: string, now = new Date()) {
  const current = now.getHours() * 60 + now.getMinutes();
  const startParts = start.split(":");
  const endParts = end.split(":");
  if (startParts.length !== 2 || endParts.length !== 2) return false;

  const startTotal = Number(startParts[0]) * 60 + Number(startParts[1]);
  const endTotal = Number(endParts[0]) * 60 + Number(endParts[1]);
  if (!Number.isFinite(startTotal) || !Number.isFinite(endTotal)) return false;

  if (startTotal <= endTotal) {
    return current >= startTotal && current < endTotal;
  }
  return current >= startTotal || current < endTotal;
}
