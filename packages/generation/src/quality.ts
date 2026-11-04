import { AI_SLOP_PHRASES } from "@zyquor/core";
import type { GenerateDraftCandidatesInput, GenerationProviderName } from "./types.js";

export const DEFAULT_QUALITY_MIN = 7;

export function qualityMinimum() {
  const configured = process.env.ZYQUOR_QUALITY_MIN?.trim();
  const value = configured ? Number(configured) : Number.NaN;
  return Number.isFinite(value) ? Math.min(10, Math.max(0, value)) : DEFAULT_QUALITY_MIN;
}

export const DEFAULT_REPLY_QUALITY_MIN = 5;

// Reply floor for the approval screen. `scoreTweetQuality`'s payoff and
// specific-noun checks were calibrated on full-length posts (220-480 chars);
// one-line replies rarely accumulate enough of that vocabulary to reach the
// post floor even when they are clean and carry a real consequence. The reply
// screen still enforces cleanliness, the recap/artifact checks, and a payoff
// signal through the same scorer, just with a floor that matches the format.
export function replyQualityMinimum() {
  const configured = process.env.ZYQUOR_REPLY_QUALITY_MIN?.trim();
  const value = configured ? Number(configured) : Number.NaN;
  return Number.isFinite(value) ? Math.min(10, Math.max(0, value)) : DEFAULT_REPLY_QUALITY_MIN;
}

const INTERNAL_LEAK_PATTERNS = [
  /\bSourcePackets?\b/i,
  /\bsource packets?\b/i,
  /\bCompact input\b/i,
  /\bcandidate tweet\b/i,
  /\bdraft candidate\b/i,
  /\bstrict JSON\b/i,
  /\b(?:candidate|draft|source) metadata\b/i,
  /\bgrounded facts?\b/i,
  /\bsource context\b/i,
  /\bzyquor\b/i,
  /<\/?source-(?:title|url)/i,
  /\bI distilled\b/i,
  /\bdistill(ed|ing)?\b.*\b(article|announcement|content)\b/i
];
const INCOMPLETE_PATTERNS = [
  /\.\.\.$/,
  /…$/,
  /\b(read more|continue reading|more below)\b/i,
  /[:;,]\s*$/
];
const AI_SLOP_PATTERNS = AI_SLOP_PHRASES.map(
  (phrase) => new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
);
const GENERIC_SLOP_PATTERNS = [
  /\bgame[- ]chang(er|ing)\b/i,
  /\bunlock\b/i,
  /\bleverage\b/i,
  /\bsynergy\b/i,
  /\bin today's (fast-paced )?world\b/i,
  /\bnow more than ever\b/i,
  /\bas an ai\b/i,
  /\blet that sink in\b/i,
  /\bread that again\b/i,
  /\bhere'?s the (thing|kicker)\b/i,
  /\bthe best part\?/i,
  /\bhot take:/i,
  /\bunpopular opinion\b/i,
  /\b(nobody|no one) talks about\b/i,
  /\bdelve\b/i,
  /\bmind.blowing\b/i,
  /\bthis changes everything\b/i,
  /\bthe future is here\b/i,
  /\bhere'?s why\b/i,
  /\bwhy this matters\b/i,
  /\b(?:more possibilities|new possibilities)\b/i,
  /\bit'?s not [^.!?\n]{1,60}, it'?s\b/i,
  /\b(?:is|are|was|were)n'?t just [^.!?\n]{1,60}, (?:it|they)'?(?:s|re)\b/i,
  /\b(wild|huge|insane)\.$/i
];

const WEAK_OPENER_PATTERN = /^(interesting|(?:a|quick|friendly) reminder|this shows|fun fact|breaking\b|just in|did you know|imagine|picture this|in a world)/i;

const ADJECTIVE_BLOAT_PATTERNS = [
  /\b(exciting|thrilling|groundbreaking|revolutionary|disruptive|innovative|cutting-edge|state-of-the-art|powerful|robust|seamless|effortless|comprehensive|holistic|impactful|strategic|dynamic|scalable)\b/i
];

const LINKEDIN_VOICE_PATTERNS = [
  /\b(thrilled|excited|honored|humbled|proud|grateful|blessed|journey|exciting news|big news|i'?m excited to announce|we are pleased to announce)\b/i,
  /\bleverage\b/i,
  /\bunlocking\b/i,
  /\bthought leadership\b/i,
  /\bkey takeaways\b/i
];

const WEAK_ENDING_PATTERN = /(?:\b(?:etc\.?|so|and|but|or|thoughts\??|agree\??|what do you think\??|does this resonate\??|let me know(?: what you think)?[.!?]?)|\.\.\.|…)\s*$/i;
const EM_DASH_OVERUSE_PATTERN = /(?:[—–][^—–]*){2,}/;

export function normalizeCount(count: number | undefined) {
  // Cap is a request-size guard, not a quality decision: a large pool just
  // means the top-up loop fills until it exhausts its bounded attempts.
  return Math.min(Math.max(count ?? 1, 1), 50);
}

function processTweetText(text: string, preserveCase: boolean) {
  const untagged = text.replace(/<\/?source-(?:title|url)\s*>/gi, "");
  const urls: string[] = [];
  const protectedText = untagged.replace(/https?:\/\/[^\s]+/gi, (url) => {
    const token = `\uE000${urls.length}\uE001`;
    urls.push(url);
    return token;
  });

  const normalized = protectedText
    .replace(/\r\n?/g, "\n")
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .split("\n")
    .map((line) =>
      line
        .replace(/[^\S\n]+/g, " ")
        .replace(/\s+([,.!?;:])/g, "$1")
        .replace(/:\s*$/g, ".")
        .replace(/([,.!?;:]){2,}/g, "$1")
        .trim()
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return (preserveCase ? normalized : normalized.toLowerCase())
    .replace(/\uE000(\d+)\uE001/g, (_token, index: string) => urls[Number(index)] ?? "");
}

export function formatTweetText(text: string) {
  return processTweetText(text, true);
}

export function postProcessTweetText(text: string) {
  return processTweetText(text, false);
}

function containsAdjectiveBloat(text: string) {
  return ADJECTIVE_BLOAT_PATTERNS.some((pattern) => pattern.test(text));
}

function containsLinkedInVoice(text: string) {
  return LINKEDIN_VOICE_PATTERNS.some((pattern) => pattern.test(text));
}

function containsGenericSlop(text: string) {
  return AI_SLOP_PATTERNS.some((pattern) => pattern.test(text)) || GENERIC_SLOP_PATTERNS.some((pattern) => pattern.test(text));
}

const PAYOFF_PATTERNS = [
  /\b(?:if|unless|until|whenever)\b/i,
  /\bwhen\b(?! it comes to)/i,
  /\b(?:which|that) means\b/i,
  /\bbecause\b/i,
  /\bbut\b/i,
  /\bso (?:you|they|we|i|the|it)\b/i,
  /\bstopped? \w+ing\b/i,
  /\b(?:instead of|rather than|not worth|only|by removing|the (?:cost|tradeoff|catch|limit|constraint|difference|point|question) is)\b/i,
  /\btrade[- ]?offs?\b/i,
  /\b(?:gave up|replaced|after removing|without)\b/i,
  /\bturns? .{3,40} into\b/i,
  /\bmatters (?:most )?(?:to|when|because)\b/i
];

const APHORISM_PATTERNS = [
  /\bproperty of\b/i,
  /\bis the one that\b/i,
  /\bthe one that cannot\b/i,
  /\b(?:is|are) exactly the (?:part|thing|one)\b/i,
  /\bdivergent\b/i,
  /\bnot [a-z][\w ']{0,20}, it[ ']s\b/i,
  /\b(?:different|divergent|moral) (?:principles or readings|grounds for|readings of the situation)\b/i,
  /\bis (?:not |never )?[a-z][\w '-]{0,20}, (?:and )?[a-z][\w '-]{0,30} is (?:not |never )?[a-z]/i
];

const RECAP_OPENERS = [
  /^(?:a |an )?new\b/i,
  /^(?:researchers|the team|the paper|the post|the article|the release|the project|the company)\b/i,
  /^\w[\w .'-]{0,60}\b(?:released|announced|published|launched|shipped|introduced|arrives?|is here|has arrived|hits (?:v?\d|stable)|reaches stable|is now (?:a )?stable)\b/i,
  /\bafter years of\b/i
];

const SOURCE_ARTIFACT_PATTERNS = [
  /\bverified (?:facts?|part)\b/i,
  /\bknown summary\b/i,
  /\bsource (?:title|name)\b/i,
  /\bthis milestone\b/i,
  /\b(?:workflow )?impact is\b/i
];

function containsAphorism(text: string) {
  return APHORISM_PATTERNS.some((pattern) => pattern.test(text));
}

function countPayoffSignals(text: string) {
  return PAYOFF_PATTERNS.filter((pattern) => pattern.test(text)).length;
}

function looksLikeSourceRecap(text: string) {
  // First-person-led posts carry the author's own stake, so release verbs
  // ("I shipped v2.4") describe personal work rather than a third-party recap.
  if (/^(i|we|my|our)\b/i.test(text.trim())) return false;
  return RECAP_OPENERS.some((pattern) => pattern.test(text.trim()));
}

// Third-party changelog regurgitation: version-led ("llm 0.33"), dense with
// API/method tokens (embed_multi, self.key, Foo.bar()), and no first-person
// stake. Reads as jargon noise even when factually correct, so it must never
// ride the autopost lane. First-person posts about the author's own work are
// exempt: the personal stake is exactly what makes them postable.
const CHANGELOG_VERSION_PATTERN = /\bv?\d+\.\d+(?:\.\d+)?\b/;
const CODE_TOKEN_PATTERNS = [
  /\b[a-zA-Z_][\w$]*\([^()\n]*\)/,
  /\b[a-z]+(?:_[a-z0-9]+){1,}\b/,
  /\bself\.\w+\b/
];
const FIRST_PERSON_PATTERN = /\b(i|we|my|our|i'm|i've)\b/i;

function looksLikeThirdPartyChangelog(text: string) {
  if (FIRST_PERSON_PATTERN.test(text)) return false;
  if (!CHANGELOG_VERSION_PATTERN.test(text)) return false;
  return CODE_TOKEN_PATTERNS.some((pattern) => pattern.test(text));
}

function containsSourceArtifact(text: string) {
  return SOURCE_ARTIFACT_PATTERNS.some((pattern) => pattern.test(text));
}

function countSpecificNouns(text: string) {
  const technical = /\b(model|database|API|kernel|compiler|chip|GPU|CPU|LLM|agent|router|index|cache|queue|token|protocol|framework|library|repo|repository|commit|release|version|patch|benchmark|latency|throughput|dataset|embedding|vector|cluster|node|pod|container|function|service|endpoint|query|transaction|inference|training|fine-tuning|distillation|quantization|attention|transformer|diffusion|RAG|SLM|MoE|dense|sparse|search|symbol|definition|mention|text)\b/gi;
  return (text.match(technical) ?? []).length;
}

export function scoreTweetQuality(text: string) {
  const trimmed = text.trim();
  const payoffSignals = countPayoffSignals(trimmed);
  let score = 3;
  if (/[0-9]/.test(trimmed)) score += 1;                 // concrete number
  if (/https?:\/\//.test(trimmed)) score += 1;           // source link
  score += Math.min(countSpecificNouns(trimmed), 3);     // specific vocabulary
  if (payoffSignals > 0) score += 2;                     // real consequence/tradeoff/decision
  if (containsSourceArtifact(trimmed)) score -= 3;
  if (looksLikeSourceRecap(trimmed)) score -= 3;
  if (looksLikeThirdPartyChangelog(trimmed)) score -= 4;
  if (WEAK_OPENER_PATTERN.test(trimmed)) score -= 2;
  if (containsAdjectiveBloat(trimmed)) score -= 2;
  if (containsAphorism(trimmed)) score -= 3;
  return score;
}

export function isCleanTweetText(text: string) {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    !INTERNAL_LEAK_PATTERNS.some((pattern) => pattern.test(trimmed)) &&
    !INCOMPLETE_PATTERNS.some((pattern) => pattern.test(trimmed)) &&
    !containsGenericSlop(trimmed) &&
    !LINKEDIN_VOICE_PATTERNS.some((pattern) => pattern.test(trimmed)) &&
    !WEAK_ENDING_PATTERN.test(trimmed) &&
    !EM_DASH_OVERUSE_PATTERN.test(trimmed) &&
    !/^[-*[{]/.test(trimmed) &&
    !trimmed.includes("\uFFFD")
  );
}

// Demand-style opener: a reply that opens by asking the author to explain,
// show, or build their own thing reads like a lazy agent prompt, not a
// conversation. Shipped one live on 2026-10-29 and the target called it out,
// so agent reply lanes must reject this class before approval.
export const REPLY_DODGE_REASON = "interrogation_dodge";
export function isInterrogationDodgeReply(text: string) {
  const unquoted = text.trim().replace(/^["'\u201c\u201d]/, "");
  return /^(?:explain|describe|tell\s+me|show\s+me|walk\s+me|can\s+you|could\s+you|would\s+you|please\s+(?:explain|describe|show|make|write|do)|what\s+(?:is|are|does)|what\s+kind\s+of|how\s+(?:do|does|would|to)|why\s+(?:do|does|is|are)|which\s+(?:one|part|api|class|tool|module)|make\s+me|write\s+me)\b/i.test(unquoted);
}

export function passesTweetQualityFloor(text: string, minimum = qualityMinimum()) {
  return isCleanTweetText(text) && !looksLikeSourceRecap(text) && scoreTweetQuality(text) >= minimum;
}

export function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseJsonCandidateTexts(raw: string, count: number): string[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  let parsed: { candidates?: Array<{ text?: unknown } | string> };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { candidates?: Array<{ text?: unknown } | string> };
  } catch {
    return null;
  }
  if (!("candidates" in parsed)) {
    return null;
  }

  return (parsed.candidates ?? [])
    .map((candidate) => (typeof candidate === "string" ? candidate : asText(candidate.text)))
    .filter(Boolean)
    .slice(0, count);
}

function cleanLineCandidate(line: string) {
  return line
    .replace(/^[-*\d.)\s"]+/, "")
    .replace(/^draft\s*\d+\s*:\s*/i, "")
    .replace(/"$/, "")
    .trim();
}

const REASONING_LINE_PATTERNS = [
  /^(?:we|i) (?:must|should|need to|will|can|could)\b/i,
  /^(?:let me|let's|first|next|now|okay|ok|so),?\b.{0,20}(?:write|draft|check|make|consider|think)\b/i,
  /^(?:option|candidate|draft|version|variant)\s*\d*\s*[:.-]/i,
  /^(?:here (?:are|is)|the following|these are)\b/i,
  /\b(?:character count|char count|word count)\b/i,
  /^(?:note|reasoning|analysis|plan|constraint)s?\s*[:-]/i
];

function looksLikeReasoningLine(line: string) {
  return REASONING_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function numberTokensIn(text: string) {
  const withoutUrls = text.replace(/https?:\/\/[^\s<>]+/gi, "");
  return (withoutUrls.match(/\b\d[\d,.]*(?:%|[a-z]+)?\b/gi) ?? []).map((token) => token.toLowerCase());
}

function suppliedText(input: GenerateDraftCandidatesInput) {
  return [
    input.idea,
    input.context?.title,
    input.context?.url,
    input.context?.author,
    input.context?.sourceName,
    input.context?.summary,
    ...(input.context?.facts ?? [])
  ].filter((value): value is string => typeof value === "string").join("\n");
}

function isGroundedCandidate(text: string, input: GenerateDraftCandidatesInput) {
  const supplied = suppliedText(input);
  const suppliedNumbers = new Set(numberTokensIn(supplied));
  return numberTokensIn(text).every((token) => suppliedNumbers.has(token));
}

function stripGeneratedUrls(text: string, preserveCase: boolean) {
  const normalize = preserveCase ? formatTweetText : postProcessTweetText;
  return normalize(
    text
      .replace(/\[([^\]]+)\]\(https?:\/\/[^)\s]+\)/gi, "$1")
      .replace(/https?:\/\/[^\s<>]+/gi, "")
      .replace(/[ \t]+([,.!?;:])/g, "$1")
  );
}

export function parseCandidateTexts(raw: string, count: number) {
  try {
    const parsed = parseJsonCandidateTexts(raw, count);
    if (parsed !== null) {
      return parsed;
    }
  } catch {
  }

  return raw
    .split(/\n+/)
    .map(cleanLineCandidate)
    .filter((line) => line.length > 0 && !looksLikeReasoningLine(line))
    .slice(0, count);
}

export function candidatesFromText(
  raw: string,
  input: GenerateDraftCandidatesInput,
  provider: GenerationProviderName,
  model: string
) {
  const count = normalizeCount(input.count);
  const texts = parseCandidateTexts(raw, count * 2)
    .map((text) => (input.preserveCase ? formatTweetText(text) : postProcessTweetText(text)))
    .map((text) => stripGeneratedUrls(text, input.preserveCase === true))
    .filter((text, index, all) => {
      const normalized = text.toLowerCase().replace(/\s+/g, " ");
      return (
        isCleanTweetText(text) &&
        isGroundedCandidate(text, input) &&
        all.findIndex((candidate) => candidate.toLowerCase().replace(/\s+/g, " ") === normalized) === index
      );
    });
  if (texts.length === 0) {
    throw new Error(`${provider} returned no draft candidates`);
  }

  return texts.slice(0, count).map((text, index) => ({
    text,
    score: {
      provider,
      model,
      rank: index + 1,
      quality: scoreTweetQuality(text)
    }
  }));
}

export function isNoCandidatesError(error: unknown, provider: GenerationProviderName) {
  return error instanceof Error && error.message === `${provider} returned no draft candidates`;
}
