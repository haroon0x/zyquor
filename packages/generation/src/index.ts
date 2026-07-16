import { AI_SLOP_PHRASES } from "@zyquor/core";
import { renderSourceContext } from "./harness.js";

export type GenerationProviderName = "openrouter" | "gemini" | "ollama";

export interface GenerateDraftCandidatesInput {
  bannedPhrases?: string[];
  context?: import("./harness.js").TweetSourceContext;
  examplePosts?: string[];
  idea: string;
  count?: number;
  objective?: string;
  recentPostHistory?: string[];
  replyContext?: { authorHandle: string; url: string };
  systemPromptExtra?: string;
  tone?: string | null;
  tweetType?: string;
}

const DEFAULT_CHARACTER_LIMIT = 280;

export interface GeneratedDraftCandidate {
  text: string;
  score: Record<string, unknown>;
}

export interface DraftGenerationProvider {
  name: GenerationProviderName;
  model: string;
  generateDraftCandidates(input: GenerateDraftCandidatesInput): Promise<GeneratedDraftCandidate[]>;
}

export interface GenerationProviderConfig {
  provider: GenerationProviderName;
  model: string;
  configured: boolean;
  baseUrl?: string;
}

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface GenerationEnvironment {
  ZYQUOR_LLM_PROVIDER?: string;
  ZYQUOR_GEMINI_API_KEY?: string;
  ZYQUOR_GEMINI_BASE_URL?: string;
  ZYQUOR_GEMINI_MODEL?: string;
  ZYQUOR_OPENROUTER_API_KEY?: string;
  ZYQUOR_OPENROUTER_BASE_URL?: string;
  ZYQUOR_OPENROUTER_MODEL?: string;
  ZYQUOR_OLLAMA_BASE_URL?: string;
  ZYQUOR_OLLAMA_MODEL?: string;
}

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "openrouter/owl-alpha";
export const OPENROUTER_MODELS = [
  "openrouter/owl-alpha",
  "nex-agi/nex-n2-pro:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "z-ai/glm-4.5-air:free",
  "moonshotai/kimi-k2.6:free",
  "poolside/laguna-xs.2:free",
  "poolside/laguna-m.1:free",
  "liquid/lfm-2.5-1.2b-thinking:free",
  "liquid/lfm-2.5-1.2b-instruct:free"
] as const;
const ALLOWED_OPENROUTER_MODELS = OPENROUTER_MODELS;
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
export const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-1.5-flash"
] as const;
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.1";
export const OLLAMA_MODELS = [
  "llama3.1",
  "llama3.1:8b",
  "qwen3:8b",
  "qwen2.5:7b",
  "mistral:7b"
] as const;
export const GENERATION_MODEL_OPTIONS = {
  openrouter: OPENROUTER_MODELS,
  gemini: GEMINI_MODELS,
  ollama: OLLAMA_MODELS
} satisfies Record<GenerationProviderName, readonly string[]>;
const INTERNAL_LEAK_PATTERNS = [
  /\bSourcePackets?\b/i,
  /\bsource packets?\b/i,
  /\bCompact input\b/i,
  /\bcandidate tweet\b/i,
  /\bdraft candidate\b/i,
  /\bstrict JSON\b/i,
  /\bmetadata\b/i,
  /\bgrounded facts?\b/i,
  /\bsource context\b/i,
  /\bI distilled\b/i,
  /\bdistill(ed|ing)?\b.*\b(article|announcement|content)\b/i
];
const INCOMPLETE_PATTERNS = [
  /\.\.\.$/,
  /…$/,
  /\b(read more|continue reading|more below)\b/i,
  /[:;,]\s*$/
];
const GENERIC_SLOP_PATTERNS = [
  /\bgame.chang(er|ing)\b/i,
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
  /\bit'?s not [^.!?\n]{1,60}, it'?s\b/i,
  /\b(wild|huge|insane)\.$/i
];

function normalizeCount(count: number | undefined) {
  return Math.min(Math.max(count ?? 3, 1), 5);
}

function normalizeIdea(idea: string) {
  return idea.trim().replace(/\s+/g, " ");
}

export function postProcessTweetText(text: string) {
  const urls: string[] = [];
  const protectedText = text.replace(/https?:\/\/[^\s]+/gi, (url) => {
    const token = `\uE000${urls.length}\uE001`;
    urls.push(url);
    return token;
  });

  return protectedText
    .replace(/\r\n?/g, "\n")
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .split("\n")
    .map((line) =>
      line
        .replace(/[^\S\n]+/g, " ")
        .replace(/\s+([,.!?;:])/g, "$1")
        .replace(/([,.!?;:]){2,}/g, "$1")
        .trim()
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .toLowerCase()
    .replace(/\uE000(\d+)\uE001/g, (_token, index: string) => urls[Number(index)] ?? "");
}

function characterLimit(input: GenerateDraftCandidatesInput) {
  return DEFAULT_CHARACTER_LIMIT;
}

const AUTHENTICITY_RULES = [
  "Sound human: plain words, one useful point, no corporate or ad voice.",
  "Start with substance, never 'just', 'so', or 'ok so'. No throat-clearing, hook formulas, colon-led setups ('here's the thing:'), or 'it's not X, it's Y'.",
  "Post-processing lowercases text. Write lowercase-compatible prose, never use capitals for emphasis; proper nouns and acronyms are fine.",
  "No engagement-bait question at the end. Give opinions a reason and end on a concrete implication.",
  "Use simple punctuation. Reserve line breaks, '-' lists, and '>' timelines for content that needs them."
];

const VOICE_EXAMPLES = [
  "Voice calibration. These pairs show tone and shape only. Never reuse their facts, topics, or wording.",
  "Weak: 'AI tools will change coding forever.'",
  "Strong: 'our 6-person team capped prs at 200 lines; median review time fell from 2 hours to 35 minutes.'",
  "Weak: 'Startups should talk to users more.'",
  "Strong: '7 customer calls brought 43 signups. a week of scheduled posts brought 2.'",
  "Weak: 'This database changes everything.'",
  "Strong: 'sqlite served 8 million rows on a $20 server; write contention forced the postgres move.'"
];

const PUNCTUATION_RULES = [
  "Never use em or en dashes (— or –)."
];

function tweetTypeInstruction(tweetType: string | undefined) {
  if (!tweetType) {
    return "General value post: state one useful fact or claim and why it matters.";
  }

  const labels: Record<string, string> = {
    feed_observation:
      "Feed observation: write in first person, name a supplied pattern, and make one clear claim about it. No hedging; 'imo' is fine, 'i think maybe' is not.",
    news_context:
      "News context: give the second-order implication, including who is affected and what changes. Do not restate the headline.",
    useful_info:
      "Useful info: lead with one supplied fact or distinction, then state its practical use or consequence.",
    guide:
      "Guide: give 2-3 compact, actionable steps or one decision rule grounded in supplied details. No generic checklist.",
    lesson:
      "Lesson: tie one learned principle to a supplied event or example, then say what to do differently. No fortune-cookie moral.",
    opinion:
      "Opinion: write in first person and make one clear claim with its reason. No hedging; 'imo' is fine, 'i think maybe' is not.",
    reply:
      "Reply: reference the author's point concretely and add one useful fact, correction, or experience. Never restate the post or give 'great post!' energy.",
    tool:
      "Tool: name the tool, the exact task it helps with, and when to use it; include a supplied limitation or tradeoff when present.",
    hiring:
      "Hiring: include the role, company, one supplied detail such as stack, location, or compensation, the exact source link, and the disclosure 'sharing, not affiliated'.",
    article_summary:
      "Article summary: give the one useful takeaway in your own words plus the exact link. Vary openings: takeaway first; 'i'd read this for [insight]'; '[result] is the part worth keeping.'",
    narrative_history:
      "Narrative history: build a compact arc from verified dates, names, and events, then close on their consequence. '>' timeline lines are optional. Never invent causality or attribution."
  };

  return labels[tweetType] ?? `${tweetType}: state one supplied fact or claim and why it matters.`;
}

const WEAK_OPENER_PATTERN = /^(interesting|a reminder|this shows|fun fact|breaking:|just in|imagine|picture this|in a world)/i;

const ADJECTIVE_BLOAT_PATTERNS = [
  /\b(exciting|thrilling|groundbreaking|revolutionary|disruptive|innovative|cutting-edge|state-of-the-art|powerful|robust|seamless|effortless|comprehensive|holistic|impactful|strategic|dynamic|scalable)\b/gi
];

const LINKEDIN_VOICE_PATTERNS = [
  /\b(thrilled|excited|honored|humbled|proud|grateful|blessed|journey|exciting news|big news|i'?m excited to announce|we are pleased to announce)\b/i,
  /\bleverage\b/i,
  /\bunlocking\b/i,
  /\bthought leadership\b/i,
  /\bkey takeaways\b/i
];

const WEAK_ENDING_PATTERN = /\b(etc\.?|\.\.\.|…|\bso\b|and\b|but\b|or\b)\s*$/i;

function containsAdjectiveBloat(text: string) {
  return ADJECTIVE_BLOAT_PATTERNS.some((pattern) => pattern.test(text));
}

function containsLinkedInVoice(text: string) {
  return LINKEDIN_VOICE_PATTERNS.some((pattern) => pattern.test(text));
}

function hasWeakEnding(text: string) {
  return WEAK_ENDING_PATTERN.test(text.trim());
}

function scoreReadability(text: string) {
  let score = 0;
  if (text.length >= 90 && text.length <= 260) score += 1;
  if (text.length < 60) score -= 1;
  if (text.length > 270) score -= 1;
  return score;
}

function countNamedEntities(text: string) {
  return (text.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/g) ?? []).length;
}

function countSpecificNouns(text: string) {
  const technical = /\b(model|database|API|kernel|compiler|chip|GPU|CPU|LLM|agent|router|index|cache|queue|token|protocol|framework|library|repo|commit|release|version|patch|benchmark|latency|throughput|dataset|embedding|vector|cluster|node|pod|container|function|service|endpoint|query|transaction|inference|training|fine-tuning|distillation|quantization|attention|transformer|diffusion|RAG|SLM|MoE|dense|sparse)\b/gi;
  return (text.match(technical) ?? []).length;
}

export function scoreTweetQuality(text: string) {
  const trimmed = text.trim();
  let score = 0;
  if (/\d/.test(trimmed)) score += 2;
  if (/https?:\/\//.test(trimmed)) score += 1;
  score += scoreReadability(trimmed);
  score += countNamedEntities(trimmed);
  score += countSpecificNouns(trimmed) * 2;
  if (WEAK_OPENER_PATTERN.test(trimmed)) score -= 2;
  if (/!/.test(trimmed)) score -= 1;
  if (/\?$/.test(trimmed) && trimmed.length < 60) score -= 1;
  if (hasWeakEnding(trimmed)) score -= 1;
  if (containsAdjectiveBloat(trimmed)) score -= 2;
  if (containsLinkedInVoice(trimmed)) score -= 3;
  if (GENERIC_SLOP_PATTERNS.some((pattern) => pattern.test(trimmed))) score -= 2;
  return score;
}

export function isCleanTweetText(text: string) {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= DEFAULT_CHARACTER_LIMIT &&
    !INTERNAL_LEAK_PATTERNS.some((pattern) => pattern.test(trimmed)) &&
    !INCOMPLETE_PATTERNS.some((pattern) => pattern.test(trimmed)) &&
    !GENERIC_SLOP_PATTERNS.some((pattern) => pattern.test(trimmed)) &&
    !LINKEDIN_VOICE_PATTERNS.some((pattern) => pattern.test(trimmed)) &&
    !WEAK_ENDING_PATTERN.test(trimmed) &&
    !/^[-*[{]/.test(trimmed) &&
    !trimmed.includes("\uFFFD")
  );
}

function formatExamplePosts(examplePosts: string[] | undefined) {
  if (!examplePosts?.length) return "";
  const posts = examplePosts
    .map((post) => post.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((post) => `> ${post.slice(0, DEFAULT_CHARACTER_LIMIT).replace(/\n/g, "\n> ")}`)
    .join("\n");
  return [
    "Account calibration examples. Use these instead of the generic pairs for voice only; never copy their facts, topics, or wording:",
    posts
  ].join("\n");
}

function formatRecentHistory(history: string[] | undefined) {
  if (!history?.length) return "";
  const lines = history
    .map((post) => post.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((post, index) => `${index + 1}. ${post.slice(0, 60)}${post.length > 60 ? "..." : ""}`)
    .join("\n");
  return [
    "Recent posts. Avoid repeating their angles or phrasing:",
    lines
  ].join("\n");
}

function systemPrompt(input: GenerateDraftCandidatesInput) {
  const count = normalizeCount(input.count);
  const bannedPhrases = [...new Set([...AI_SLOP_PHRASES, ...(input.bannedPhrases ?? [])])].join(",");
  const limit = characterLimit(input);
  const voiceNotes = input.systemPromptExtra?.trim() ?? "";
  const voiceNoteLines = voiceNotes.split(/\r?\n/);
  const examplesHeadingIndex = voiceNoteLines.findIndex((line) => /examples/i.test(line));
  const voiceNotesHaveExamples =
    examplesHeadingIndex >= 0 &&
    voiceNoteLines.slice(examplesHeadingIndex + 1).some((line) => /^(?:-\s+|\d+[.)]\s+)/.test(line.trimStart()));
  const diversityInstruction =
    count >= 3
      ? "Use distinct substantive angles: key fact and meaning; who is affected; practical implication. Do not return paraphrases."
      : "Give each candidate a distinct substantive angle, not a paraphrase.";
  return [
    "Role",
    "Write public X post candidates in the account owner's voice. Write text only.",
    "Non-negotiable rules",
    "Never decide whether or when to post, rank candidates, fetch or browse anything, or claim to have opened a link.",
    `Write complete, standalone public text, never teasers or thread continuations. Maximum ${limit} characters per candidate.`,
    "Use only supplied facts. Each candidate needs a specific fact, number, name, or example from the input. Never invent details or causality; narrow thin claims.",
    "For source-backed posts, preserve the exact supplied URL and use only the supplied <source-title> for attribution.",
    "No hashtags unless the idea contains one. No emojis unless the idea contains one. Never write 'thread 🧵'.",
    "Never expose internal terms such as SourcePacket, source context, candidate, draft, metadata, JSON, prompt, or grounded facts.",
    `Never use these AI-slop or account-banned phrases: ${bannedPhrases}.`,
    "Voice",
    ...AUTHENTICITY_RULES,
    ...PUNCTUATION_RULES,
    "Tweet type",
    tweetTypeInstruction(input.tweetType),
    "Calibration examples",
    input.examplePosts?.length
      ? formatExamplePosts(input.examplePosts)
      : voiceNotesHaveExamples
        ? "Use the example tweets in Account voice notes instead of the generic calibration pairs."
        : VOICE_EXAMPLES.join("\n"),
    "User style",
    `Tone: ${input.tone?.trim() || "clear, useful, direct"}.`,
    input.objective?.trim() ? `Objective: ${input.objective.trim()}.` : "",
    formatRecentHistory(input.recentPostHistory),
    voiceNotes
      ? `Account voice notes${voiceNotesHaveExamples ? " (example tweets below override the generic calibration pairs)" : ""}:\n${voiceNotes}`
      : "",
    "Output format",
    diversityInstruction,
    `Return exactly ${count} non-empty candidates as strict JSON only: {"candidates":[{"text":"first draft"},{"text":"second draft"}]}.`
  ]
    .filter(Boolean)
    .join("\n");
}

function userPrompt(input: GenerateDraftCandidatesInput) {
  const replyInstruction = input.replyContext
    ? `You are drafting a reply to @${input.replyContext.authorHandle}'s post at ${input.replyContext.url}. Write a useful reply using the user's description of the target post below. Do not claim to have opened or read the linked post.`
    : "";
  return `${replyInstruction ? `${replyInstruction}\n\n` : ""}Context to turn into public X posts:\n${normalizeIdea(input.idea)}${renderSourceContext(input.context)}`;
}

function linePrompt(input: GenerateDraftCandidatesInput) {
  const count = normalizeCount(input.count);
  const limit = characterLimit(input);
  return [
    `Write exactly ${count} concise X post drafts about this idea: ${normalizeIdea(input.idea)}`,
    tweetTypeInstruction(input.tweetType),
    input.replyContext
      ? `You are drafting a reply to @${input.replyContext.authorHandle}'s post at ${input.replyContext.url}. Write a useful reply using the user's description of the target post. Do not claim to have opened or read the linked post.`
      : "",
    `Each draft must be ${limit} characters or fewer.`,
    "One draft per line.",
    "No numbering, no labels, no JSON.",
    "Each line takes a different angle on the idea, not a paraphrase.",
    "Write like a person typing one useful thought. Include a supplied fact, number, name, or example; no pure vibes.",
    "Never start with 'just', 'so', or 'ok so'. No hook formulas, colon-led setups, engagement-bait endings, or 'thread 🧵'.",
    "Write naturally lowercase-compatible text; never rely on capitals for emphasis.",
    "Never mention SourcePacket, source packet, compact input, candidate, draft, metadata, prompt, or distillation.",
    "Use only supplied facts. Never fetch, rank, schedule, or decide whether to post.",
    "No hashtags unless the idea contains one. No emojis unless the idea contains one.",
    `Never use these AI-slop or account-banned phrases: ${[...new Set([...AI_SLOP_PHRASES, ...(input.bannedPhrases ?? [])])].join(",")}.`,
    ...PUNCTUATION_RULES
  ].filter(Boolean).join("\n");
}

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function parseJsonCandidateTexts(raw: string, count: number): string[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const parsed = JSON.parse(raw.slice(start, end + 1)) as { candidates?: Array<{ text?: unknown } | string> };
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

function parseCandidateTexts(raw: string, count: number) {
  try {
    const parsed = parseJsonCandidateTexts(raw, count);
    if (parsed !== null) {
      return parsed;
    }
  } catch {
    // Fall through to line parser. Some local models wrap JSON in prose.
  }

  return raw
    .split(/\n+/)
    .map(cleanLineCandidate)
    .filter((line) => line.length > 0)
    .slice(0, count);
}

function candidatesFromText(raw: string, input: GenerateDraftCandidatesInput, provider: GenerationProviderName, model: string) {
  const count = normalizeCount(input.count);
  const limit = characterLimit(input);
  const texts = parseCandidateTexts(raw, count * 2)
    .map(postProcessTweetText)
    .filter((text, index, all) => {
      const normalized = text.toLowerCase().replace(/\s+/g, " ");
      return (
        text.length <= limit &&
        isCleanTweetText(text) &&
        all.findIndex((candidate) => candidate.toLowerCase().replace(/\s+/g, " ") === normalized) === index
      );
    });
  if (texts.length === 0) {
    throw new Error(`${provider} returned no draft candidates`);
  }

  return texts
    .map((text, index) => ({ text, modelOrder: index, quality: scoreTweetQuality(text) }))
    .sort((a, b) => b.quality - a.quality || a.modelOrder - b.modelOrder)
    .slice(0, count)
    .map(({ text, quality }, index) => ({
      text,
      score: {
        provider,
        model,
        rank: index + 1,
        quality
      }
    }));
}

function isNoCandidatesError(error: unknown, provider: GenerationProviderName) {
  return error instanceof Error && error.message === `${provider} returned no draft candidates`;
}

function safeOpenRouterModel(model: string | undefined) {
  if (!model) return DEFAULT_OPENROUTER_MODEL;
  return (ALLOWED_OPENROUTER_MODELS as readonly string[]).includes(model) ? model : DEFAULT_OPENROUTER_MODEL;
}

function isZeroPrice(value: unknown) {
  return typeof value === "string" && Number(value) === 0;
}

function assertOpenRouterPricingIsFree(input: {
  model: string;
  pricing?: { completion?: unknown; prompt?: unknown; request?: unknown };
}) {
  if (!input.pricing || !isZeroPrice(input.pricing.prompt) || !isZeroPrice(input.pricing.completion)) {
    throw new Error(`OpenRouter model is not confirmed free: ${input.model}`);
  }
}

async function postJson<T>(fetchImpl: FetchLike, url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Generation request failed: ${response.status}${detail ? ` ${detail}` : ""}`);
  }

  return (await response.json()) as T;
}

async function getJson<T>(fetchImpl: FetchLike, url: string, headers: Record<string, string> = {}) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Generation metadata request failed: ${response.status}${detail ? ` ${detail}` : ""}`);
  }

  return (await response.json()) as T;
}

export function createOllamaGenerationProvider(options: {
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
} = {}): DraftGenerationProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_OLLAMA_MODEL;
  const fetchImpl = options.fetch ?? fetch;

  return {
    name: "ollama",
    model,
    async generateDraftCandidates(input) {
      const count = normalizeCount(input.count);
      try {
        const body = await postJson<{ response?: unknown }>(fetchImpl, `${baseUrl}/api/generate`, {
          model,
          system: systemPrompt(input),
          prompt: userPrompt(input),
          stream: false,
          format: "json",
          options: {
            temperature: 0.6,
            num_predict: 900
          }
        });

        return candidatesFromText(asText(body.response), input, "ollama", model);
      } catch (error) {
        if (!isNoCandidatesError(error, "ollama")) {
          throw error;
        }

        const retryBody = await postJson<{ response?: unknown }>(fetchImpl, `${baseUrl}/api/generate`, {
          model,
          prompt: linePrompt(input),
          stream: false,
          options: {
            temperature: 0.5,
            num_predict: 500
          }
        });

        return candidatesFromText(asText(retryBody.response), input, "ollama", model);
      }
    }
  };
}

export function createOpenRouterGenerationProvider(options: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
}): DraftGenerationProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const model = safeOpenRouterModel(options.model);
  const fetchImpl = options.fetch ?? fetch;
  let confirmedFree = false;

  async function assertFreeModel() {
    if (confirmedFree) return;
    const body = await getJson<{
      data?: Array<{ id?: unknown; pricing?: { completion?: unknown; prompt?: unknown; request?: unknown } }>;
    }>(fetchImpl, `${baseUrl}/models`, {
      authorization: `Bearer ${options.apiKey}`
    });
    const modelMetadata = body.data?.find((item) => item.id === model);
    assertOpenRouterPricingIsFree({
      model,
      ...(modelMetadata?.pricing ? { pricing: modelMetadata.pricing } : {})
    });
    confirmedFree = true;
  }

  return {
    name: "openrouter",
    model,
    async generateDraftCandidates(input) {
      await assertFreeModel();
      const url = `${baseUrl}/chat/completions`;
      const headers = {
        authorization: `Bearer ${options.apiKey}`,
        "http-referer": "http://127.0.0.1",
        "x-title": "Zyquor"
      };

      try {
        const body = await postJson<{
          choices?: Array<{ message?: { content?: unknown } }>;
        }>(
          fetchImpl,
          url,
          {
            model,
            messages: [
              { role: "system", content: systemPrompt(input) },
              { role: "user", content: userPrompt(input) }
            ],
            response_format: { type: "json_object" },
            temperature: 0.65,
            max_tokens: 900
          },
          headers
        );
        const text = asText(body.choices?.[0]?.message?.content);
        return candidatesFromText(text, input, "openrouter", model);
      } catch (error) {
        if (!isNoCandidatesError(error, "openrouter")) {
          throw error;
        }

        const retryBody = await postJson<{
          choices?: Array<{ message?: { content?: unknown } }>;
        }>(
          fetchImpl,
          url,
          {
            model,
            messages: [{ role: "user", content: linePrompt(input) }],
            temperature: 0.5,
            max_tokens: 500
          },
          headers
        );
        const retryText = asText(retryBody.choices?.[0]?.message?.content);
        return candidatesFromText(retryText, input, "openrouter", model);
      }
    }
  };
}

export function createGeminiGenerationProvider(options: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
}): DraftGenerationProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const fetchImpl = options.fetch ?? fetch;

  return {
    name: "gemini",
    model,
    async generateDraftCandidates(input) {
      const body = await postJson<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
      }>(fetchImpl, `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`, {
        systemInstruction: {
          parts: [{ text: systemPrompt(input) }]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: userPrompt(input) }]
          }
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.65,
          maxOutputTokens: 900
        }
      });
      const text = asText(body.candidates?.[0]?.content?.parts?.map((part) => asText(part.text)).join("\n"));
      return candidatesFromText(text, input, "gemini", model);
    }
  };
}

export function resolveGenerationProviderConfig(env: GenerationEnvironment = process.env): GenerationProviderConfig {
  const requestedProvider = (env.ZYQUOR_LLM_PROVIDER ?? "auto").toLowerCase();
  const provider = (
    requestedProvider === "auto"
      ? env.ZYQUOR_OPENROUTER_API_KEY
        ? "openrouter"
        : env.ZYQUOR_GEMINI_API_KEY
          ? "gemini"
          : env.ZYQUOR_OLLAMA_BASE_URL || env.ZYQUOR_OLLAMA_MODEL
          ? "ollama"
          : "ollama"
      : requestedProvider
  ) as GenerationProviderName;

  if (provider === "openrouter") {
    return {
      provider,
      model: safeOpenRouterModel(env.ZYQUOR_OPENROUTER_MODEL),
      baseUrl: env.ZYQUOR_OPENROUTER_BASE_URL ?? DEFAULT_OPENROUTER_BASE_URL,
      configured: Boolean(env.ZYQUOR_OPENROUTER_API_KEY)
    };
  }

  if (provider === "gemini") {
    return {
      provider,
      model: env.ZYQUOR_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
      baseUrl: env.ZYQUOR_GEMINI_BASE_URL ?? DEFAULT_GEMINI_BASE_URL,
      configured: Boolean(env.ZYQUOR_GEMINI_API_KEY)
    };
  }

  if (provider === "ollama") {
    return {
      provider,
      model: env.ZYQUOR_OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL,
      baseUrl: env.ZYQUOR_OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
      configured: true
    };
  }

  throw new Error(`Unsupported LLM provider: ${provider}`);
}

export function createGenerationProviderFromEnv(
  env: GenerationEnvironment = process.env,
  fetchImpl: FetchLike = fetch
): DraftGenerationProvider {
  const config = resolveGenerationProviderConfig(env);

  if (config.provider === "ollama") {
    return createOllamaGenerationProvider({
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      model: config.model,
      fetch: fetchImpl
    });
  }

  if (config.provider === "openrouter") {
    if (!env.ZYQUOR_OPENROUTER_API_KEY) {
      throw new Error("ZYQUOR_OPENROUTER_API_KEY is required when ZYQUOR_LLM_PROVIDER=openrouter");
    }
    return createOpenRouterGenerationProvider({
      apiKey: env.ZYQUOR_OPENROUTER_API_KEY,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      model: config.model,
      fetch: fetchImpl
    });
  }

  if (config.provider === "gemini") {
    if (!env.ZYQUOR_GEMINI_API_KEY) {
      throw new Error("ZYQUOR_GEMINI_API_KEY is required when ZYQUOR_LLM_PROVIDER=gemini");
    }
    return createGeminiGenerationProvider({
      apiKey: env.ZYQUOR_GEMINI_API_KEY,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      model: config.model,
      fetch: fetchImpl
    });
  }

  throw new Error(`Unsupported LLM provider: ${config.provider}`);
}

export * from "./harness.js";
