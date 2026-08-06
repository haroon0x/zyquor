import type { PostHistory, SourcePacket } from "@zyquor/core";
import { AI_SLOP_PHRASES } from "@zyquor/core";
import { formatTweetText, passesTweetQualityFloor } from "@zyquor/generation";

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

export function validateGeneratedPostQuality(text: string): PostQualityResult {
  const normalized = formatTweetText(text);
  const reasons: string[] = [];
  if (normalized.length === 0) reasons.push("empty_post_text");
  if (!passesTweetQualityFloor(normalized)) reasons.push("post_failed_quality_floor");
  return {
    ok: reasons.length === 0,
    reasons,
    text: normalized
  };
}

const SAME_PACKET_COOLDOWN_MS = 2 * 60 * 60 * 1000;
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

// "we"/"our" + an action verb. For non-feed source packets the material is always
// someone else's work, so first-person ownership phrasing ("we built X", "we dropped
// Postgres") misattributes it to the account owner and must be rejected.
const FIRST_PERSON_MISATTRIBUTION =
  /(?:^|[\s(),;:."'])(?:we|our)\s+(?:team|company|engineering)?\s*(?:built|build|ship(?:s|ped)?|made|make|created?|launch(?:ed)?|wrote|write|developed?|designed?|deploy(?:ed)?|migrat(?:ed|ing)?|moved?|replaced?|switch(?:ed|ing)?|released?|published?|drop(?:ped)?|cut|reduced?|saved?|scal(?:ed)?|handled?|served?|processed?|r[au]n|used?|added?|removed?|introduced?|adopted?|tested?|verified?|maintained?|owned?|operated?|prototyped?)\b/i;

function containsUrl(text: string) {
  return /https?:\/\/\S+/i.test(text);
}

function sourceIsExternal(packet: SourcePacket) {
  return packet.sourceType !== "x-feed";
}

// Only article summaries carry their source URL. Other source-backed post types
// keep the URL out of the body and spend the freed characters on the detail.
function sourceNeedsLink(packet: SourcePacket) {
  return Boolean(packet.url) && sourceIsExternal(packet) && packet.tweetType === "article_summary";
}

function sourceEvidence(packet: SourcePacket) {
  return `${packet.title}\n${packet.summary}\n${packet.facts.join("\n")}`.toLowerCase();
}

function stripUrls(text: string) {
  return formatTweetText(
    text
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/gi, "$1")
      .replace(/https?:\/\/[^\s<>]+/gi, "")
      .replace(/[ \t]+([,.!?;:])/g, "$1")
  );
}

function repairQuoteTimeline(text: string) {
  const normalized = formatTweetText(text);
  if (normalized.includes("\n")) return normalized;
  const quoteCount = (normalized.match(/\s>\s/g) ?? []).length + (normalized.startsWith(">") ? 1 : 0);
  if (quoteCount < 2) return normalized;

  return formatTweetText(
    normalized
      .replace(/\s+>\s+/g, "\n> ")
      .replace(/^>\s*/, "> ")
  );
}

const TRAILING_SOURCE_LABEL = /(https?:\/\/\S+)\s+\[[^\]\n]{1,40}\]\s+.+$/;

export function stripTrailingSourceLabel(text: string) {
  return text.replace(TRAILING_SOURCE_LABEL, "$1").trimEnd();
}

function normalizeForTitleMatch(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function stripTrailingTitleEcho(text: string, title: string) {
  const match = text.match(/(https?:\/\/\S+)[\s,;:.-]+([^\n]+)$/);
  if (!match) return text;
  const echo = normalizeForTitleMatch(match[2] ?? "");
  const normalizedTitle = normalizeForTitleMatch(title);
  if (echo.length < 12 || normalizedTitle.length < 12) return text;
  if (!normalizedTitle.includes(echo) && !echo.includes(normalizedTitle)) return text;
  return text.slice(0, (match.index ?? 0) + (match[1]?.length ?? 0)).replace(/[\s,;:.-]+$/, "");
}

export function withRequiredSourceUrl(text: string, packet: SourcePacket) {
  const repaired = stripTrailingTitleEcho(stripTrailingSourceLabel(repairQuoteTimeline(text)), packet.title);
  const body = stripUrls(repaired);
  if (!sourceNeedsLink(packet) || !packet.url) return body;
  const separator = body.includes("\n") ? "\n" : " ";
  return formatTweetText(`${body}${body ? separator : ""}${packet.url}`);
}

function hasBrokenQuoteTimeline(text: string) {
  return formatTweetText(text)
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
  if (sourceNeedsLink(input.packet) && !containsUrl(text)) reasons.push("missing_required_source_url");
  if (LOW_SIGNAL_TITLE_PATTERNS.some((pattern) => pattern.test(input.packet.title))) reasons.push("low_signal_promotional_source");
  if (recentSamePacketPost(input)) reasons.push("same_source_packet_cooldown");
  if (RISKY_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text)) && !RISKY_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(evidence))) {
    reasons.push("risky_unsupported_absolute_claim");
  }
  if (sourceIsExternal(input.packet) && FIRST_PERSON_MISATTRIBUTION.test(text)) {
    reasons.push("first_person_misattribution");
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
