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
  "Sound like a person typing out a thought, not like content being produced. Plain words. No performance.",
  "Start at the point. If the first sentence is setup or throat-clearing, delete it and start at the second.",
  "One specific point per post. Let the most concrete detail, a number, a name, a mechanism, carry the post.",
  "Plain is fine. A clear statement of a genuinely interesting fact beats a styled take on a boring one.",
  "Never use hook formulas: 'Hot take:', 'Unpopular opinion:', 'Nobody talks about', 'Here's the thing', 'Let that sink in', 'Read that again', 'The best part?'.",
  "Never use the contrast template 'It's not X, it's Y'. Never end on a one-word punch like 'Wild.' or 'Huge.'.",
  "An opinion must carry its reasoning in the same post. A claim without its why is bait.",
  "Use line breaks or short '-' lists only when the content really is a list or timeline. Never force a sentence into a format.",
  "Greentext '>' timeline lines are allowed only for narrative history posts built on verified dates and facts.",
  "A sentence fragment or natural lowercase is fine when it reads like a real person typed it. No fake misspellings. No forced slang.",
  "Output every post in lowercase. No capitalized words anywhere, including proper nouns, acronyms, brand names, and the first letter of the post. This is a hard rule for the whole post.",
  "Final check per candidate: if it could appear on LinkedIn or in an ad, rewrite it plainer and more specific."
];

const VOICE_EXAMPLES = [
  "Voice calibration. These pairs show tone and shape only. Never reuse their facts, topics, or wording.",
  "Weak: 'AI agents are a game changer for software development. The future is here.'",
  "Strong: 'coding agents removed the activation energy of starting. i finally fix the stuff i ignored for months because opening the file was the hard part.'",
  "Weak: 'Unpopular opinion: most startups fail because of poor execution. Let that sink in.'",
  "Strong: 'every failed-startup post-mortem has the same line: \"we built for 18 months before talking to users.\" at some point that stops being bad luck and becomes the cause.'",
  "Weak: 'New paper alert! Researchers unlock massive gains in LLM reasoning. This changes everything.'",
  "Strong: 'New result: letting the model decide when to stop reasoning cuts inference cost about 40%. Smaller models gain more than big ones, which nobody predicted.'"
];

const PUNCTUATION_RULES = [
  "Punctuation rule: never use em dashes or en dashes. Forbidden characters: — and –.",
  "If you want a pause or contrast, use a comma, colon, period, semicolon, or parentheses instead.",
  "Hyphen is allowed only inside normal compound words or as a simple '-' list marker when a list format is chosen."
];

function tweetTypeInstruction(tweetType: string | undefined) {
  if (!tweetType) {
    return "Tweet type: general value post.";
  }

  const labels: Record<string, string> = {
    feed_observation: "Tweet type: feed observation. Turn a pattern or behavior into a useful takeaway.",
    news_context: "Tweet type: news context. Explain why the event matters without sensationalism.",
    useful_info: "Tweet type: useful info. Give a concrete fact, distinction, or practical takeaway.",
    guide: "Tweet type: guide. Give a compact how-to or decision rule.",
    lesson: "Tweet type: lesson. Share a learned principle with a specific implication.",
    opinion: "Tweet type: opinion. Make a clear argument without rage bait.",
    reply: "Tweet type: reply. Draft a useful reply to the given post. Add context or a practical point without sounding automated.",
    tool: "Tweet type: tool. Explain what a tool is useful for and when to use it.",
    hiring:
      "Tweet type: hiring. Share a real hiring post with role/company/context and the exact source link. Make it clear you are not affiliated with the company, just sharing because it may help someone.",
    article_summary:
      "Tweet type: article summary. Say what the article's genuinely useful point is in plain language, like recommending it to a friend. Include the exact source link. Vary the framing; never open every post the same way.",
    narrative_history:
      "Tweet type: narrative history. Turn verified facts into a compact historical or biographical arc with irony, delayed payoff, and a reflective closing. Greentext-style '>' timeline lines are allowed when they fit. Do not invent dates, causality, or attribution."
  };

  return labels[tweetType] ?? `Tweet type: ${tweetType}.`;
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
    .slice(0, 5)
    .map((post) => `> ${post.replace(/\n/g, "\n> ")}`)
    .join("\n");
  return [
    "Your own past posts that match your voice. Match their shape and sentence rhythm, but never copy their topics or facts:",
    posts
  ].join("\n");
}

function formatRecentHistory(history: string[] | undefined) {
  if (!history?.length) return "";
  const lines = history
    .map((post) => post.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((post, index) => `${index + 1}. ${post.slice(0, 120)}${post.length > 120 ? "..." : ""}`)
    .join("\n");
  return [
    "Your recent posts. Do not repeat these angles, topics, or phrasings; find a fresh take:",
    lines
  ].join("\n");
}

function systemPrompt(input: GenerateDraftCandidatesInput) {
  const count = normalizeCount(input.count);
  const bannedPhrases = input.bannedPhrases?.length
    ? input.bannedPhrases.join(", ")
    : "game changer, unlock, leverage, 10x, delve, dive into, revolutionize";
  const limit = characterLimit(input);
  const diversityInstruction =
    count >= 3
      ? "Angle mix: one candidate states the concrete fact and why it matters, one focuses on who it affects or what changes next, one gives a sharper personal read with its reasoning. Different angles on the substance, not different formats, not paraphrases."
      : "Each candidate must take a distinct angle on the substance, not paraphrase the same sentence.";
  return [
    "You write X posts as one human account. Everything you produce must read like that person typed it themselves.",
    "Quality bar: post only what a sharp follower in tech would find genuinely interesting. Specific beats clever. Clear beats styled. If the idea is thin, write the narrowest true observation rather than inflating it.",
    input.tone ? `Account tone: ${input.tone}.` : "Account tone: clear, useful, direct.",
    input.objective ? `Account objective: ${input.objective}.` : "Account objective: posts people save, share, and remember.",
    "Topic home turf: AI, programming, science, research, markets, startups, and tech-shaped policy, when the context supports it.",
    input.systemPromptExtra ? `Account-specific instructions (highest priority):\n${input.systemPromptExtra}` : "",
    ...AUTHENTICITY_RULES,
    ...VOICE_EXAMPLES,
    "Voice calibration: every candidate must pass the 'why should a smart follower care?' test in the first 20 words. If it does not, delete the opening and start with the useful part.",
    "Voice calibration: do not use adjectives that can be removed without changing the meaning. If you can delete the adjective and the sentence is the same, delete it.",
    "Voice calibration: the final sentence must land on a concrete implication or a specific takeaway. No trailing questions, no 'etc.', no '...', no one-word endings like 'Wild.' or 'Huge.'.",
    "Voice calibration: no LinkedIn/ad voice. Never use 'thrilled', 'humbled', 'journey', 'key takeaways', 'thought leadership', 'excited to announce', or 'leverage'.",
    ...PUNCTUATION_RULES,
    "No hashtags. No emojis. No cheap bait or fake claims.",
    "Write as the human, never as an observer of feeds or data. Never use 'I notice', 'I've noticed', 'I observe', or similar detector phrasing. Just say the thing.",
    "Grounding: use only facts supplied by the user or source context. Never invent dates, numbers, quotes, names, or causality. If facts are thin, narrow the claim instead of filling gaps.",
    "For news, give the second-order implication: who it affects, what changes, why builders or investors should care.",
    "Write only public-facing post text. Never mention internal labels like SourcePacket, source packet, compact input, candidate, draft, metadata, JSON, prompt, distillation, source context, or grounded facts.",
    "Every candidate is a complete standalone post. No teasers, no thread dependence.",
    "For source-backed posts, include the exact supplied source URL. Use only the supplied <source-title> value for attribution; never invent an author, publisher, or attribution. For hiring posts, say you are just sharing, not affiliated. For article posts, recommend the piece in your own words and vary the framing; never open every post the same way.",
    `Banned phrases: ${bannedPhrases}.`,
    `Hard limit: every candidate must be ${limit} characters or fewer.`,
    diversityInstruction,
    input.context?.facts?.length ? "Use only the provided facts. Do not add details that are not present." : "",
    formatExamplePosts(input.examplePosts),
    formatRecentHistory(input.recentPostHistory),
    `Return exactly ${count} non-empty candidates.`,
    'Return strict JSON only with this shape: {"candidates":[{"text":"first draft"},{"text":"second draft"}]}.',
    "Never return an empty candidates array."
  ]
    .filter(Boolean)
    .join("\n");
}

function userPrompt(input: GenerateDraftCandidatesInput) {
  return `${tweetTypeInstruction(input.tweetType)}\n\nContext to turn into public X posts:\n${normalizeIdea(input.idea)}${renderSourceContext(input.context)}`;
}

function linePrompt(input: GenerateDraftCandidatesInput) {
  const count = normalizeCount(input.count);
  const limit = characterLimit(input);
  return [
    `Write exactly ${count} concise X post drafts about this idea: ${normalizeIdea(input.idea)}`,
    tweetTypeInstruction(input.tweetType),
    `Each draft must be ${limit} characters or fewer.`,
    "One draft per line.",
    "No numbering, no labels, no JSON.",
    "Each line takes a different angle on the idea, not a paraphrase.",
    "Write like a person typing a thought: plain words, specific details, no hook formulas like 'Hot take:' or 'Unpopular opinion:', no corporate tone.",
    "Never mention SourcePacket, source packet, compact input, candidate, draft, metadata, prompt, or distillation.",
    "Avoid cheap bait, fake claims, hashtags, and emojis.",
    ...PUNCTUATION_RULES
  ].join("\n");
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
