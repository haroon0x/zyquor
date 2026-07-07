import type { PostHistory, SourcePacket } from "@zyquor/core";
import { AI_SLOP_PHRASES, X_FREE_POST_CHARACTER_LIMIT } from "@zyquor/core";
import { postProcessTweetText } from "@zyquor/generation";

export interface PostQualityInput {
  history?: PostHistory[];
  now?: Date;
  packet: SourcePacket;
  text: string;
}

export interface PostQualityResult {
  ok: boolean;
  reasons: string[];
  text: string;
}

const SAME_PACKET_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const SOURCE_LINK_REQUIRED_TYPES = new Set(["article_summary", "hiring"]);
const LOW_SIGNAL_TITLE_PATTERNS = [
  /\b50%\s+off\b/i,
  /\blast\s+24\s+hours?\b/i,
  /\bdiscount\b/i,
  /\bpromo\b/i,
  /\bsale\b/i,
  /\bgiveaway\b/i
];
const RISKY_UNSUPPORTED_PATTERNS = [
  /\balways\s+(safe|works|wins|fails)\b/i,
  /\bnever\s+(safe|works|wins|fails)\b/i,
  /\beveryone\s+(is|was|will|can)\b/i,
  /\bno one\s+(is|was|will|can)\b/i
];

function containsUrl(text: string) {
  return /https?:\/\/\S+/i.test(text);
}

function sourceNeedsLink(packet: SourcePacket) {
  return Boolean(packet.url) && (SOURCE_LINK_REQUIRED_TYPES.has(packet.tweetType) || packet.sourceType === "job");
}

function sourceEvidence(packet: SourcePacket) {
  return `${packet.title}\n${packet.summary}\n${packet.facts.join("\n")}`.toLowerCase();
}

function repairQuoteTimeline(text: string) {
  const normalized = postProcessTweetText(text);
  if (normalized.includes("\n")) return normalized;
  const quoteCount = (normalized.match(/\s>\s/g) ?? []).length + (normalized.startsWith(">") ? 1 : 0);
  if (quoteCount < 2) return normalized;

  return postProcessTweetText(
    normalized
      .replace(/\s+>\s+/g, "\n> ")
      .replace(/^>\s*/, "> ")
  );
}

function withRequiredSourceUrl(text: string, packet: SourcePacket) {
  const repaired = repairQuoteTimeline(text);
  if (!sourceNeedsLink(packet) || containsUrl(repaired) || !packet.url) return repaired;
  const separator = repaired.includes("\n") ? "\n" : " ";
  return postProcessTweetText(`${repaired}${separator}${packet.url}`);
}

function hasBrokenQuoteTimeline(text: string) {
  return postProcessTweetText(text)
    .split("\n")
    .some((line) => /^> .*\s> /.test(line));
}

function recentSamePacketPost(input: PostQualityInput) {
  const now = input.now ?? new Date();
  return (input.history ?? [])
    .filter((item) => item.accountId === input.packet.accountId && item.sourcePacketId === input.packet.id)
    .some((item) => now.getTime() - Date.parse(item.postedAt) < SAME_PACKET_COOLDOWN_MS);
}

export function validateSourcePostQuality(input: PostQualityInput): PostQualityResult {
  const text = withRequiredSourceUrl(input.text, input.packet);
  const reasons: string[] = [];
  const evidence = sourceEvidence(input.packet);

  if (text.length === 0) reasons.push("empty_post_text");
  if (text.length > X_FREE_POST_CHARACTER_LIMIT) reasons.push("post_text_too_long_after_quality_repair");
  if (sourceNeedsLink(input.packet) && !containsUrl(text)) reasons.push("missing_required_source_url");
  if (LOW_SIGNAL_TITLE_PATTERNS.some((pattern) => pattern.test(input.packet.title))) reasons.push("low_signal_promotional_source");
  if (recentSamePacketPost(input)) reasons.push("same_source_packet_cooldown");
  if (RISKY_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text)) && !RISKY_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(evidence))) {
    reasons.push("risky_unsupported_absolute_claim");
  }
  if (hasBrokenQuoteTimeline(text)) reasons.push("broken_quote_timeline_format");

  const lowerText = text.toLowerCase();
  for (const phrase of AI_SLOP_PHRASES) {
    if (lowerText.includes(phrase)) {
      reasons.push(`ai_slop_phrase:${phrase}`);
      break;
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    text
  };
}
