import { renderSourceContext } from "./harness.js";

export type GenerationProviderName = "openrouter" | "gemini" | "ollama";

export interface GenerateDraftCandidatesInput {
  bannedPhrases?: string[];
  context?: import("./harness.js").TweetSourceContext;
  idea: string;
  count?: number;
  objective?: string;
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
const DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";
export const OPENROUTER_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "inclusionai/ling-2.6-1t:free",
  "minimax/minimax-m2.5:free",
  "tencent/hy3-preview:free"
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
  /\bgame changer\b/i,
  /\bunlock\b/i,
  /\bleverage\b/i,
  /\bsynergy\b/i,
  /\bin today's (fast-paced )?world\b/i,
  /\bnow more than ever\b/i,
  /\bas an ai\b/i
];

function normalizeCount(count: number | undefined) {
  return Math.min(Math.max(count ?? 3, 1), 5);
}

function normalizeIdea(idea: string) {
  return idea.trim().replace(/\s+/g, " ");
}

function characterLimit(input: GenerateDraftCandidatesInput) {
  return DEFAULT_CHARACTER_LIMIT;
}

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
    tool: "Tweet type: tool. Explain what a tool is useful for and when to use it."
  };

  return labels[tweetType] ?? `Tweet type: ${tweetType}.`;
}

export function isCleanTweetText(text: string) {
  const trimmed = text.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= DEFAULT_CHARACTER_LIMIT &&
    !INTERNAL_LEAK_PATTERNS.some((pattern) => pattern.test(trimmed)) &&
    !INCOMPLETE_PATTERNS.some((pattern) => pattern.test(trimmed)) &&
    !GENERIC_SLOP_PATTERNS.some((pattern) => pattern.test(trimmed)) &&
    !/^[-*[{]/.test(trimmed) &&
    !trimmed.includes("\uFFFD")
  );
}

function systemPrompt(input: GenerateDraftCandidatesInput) {
  const count = normalizeCount(input.count);
  const bannedPhrases = input.bannedPhrases?.length ? input.bannedPhrases.join(", ") : "game changer, unlock, 10x";
  const limit = characterLimit(input);
  const diversityInstruction =
    count >= 3
      ? "Candidate mix: one direct why-it-matters post, one practical takeaway post, and one smart-bro casual post. If more candidates are requested, add a contrarian/context angle and a concise founder/operator angle."
      : "Candidate mix: make each candidate use a distinct angle, not paraphrases of the same sentence.";
  return [
    "You are Zyquor's draft generator for X posts.",
    "Write concrete, concise, review-ready draft candidates.",
    "Objective: maximize useful reach, views, and reputation by being specific, timely, clear, and valuable.",
    "Prefer angles around AI, technology, programming, science, research, economics, markets, geopolitics shaped by tech, policy, startups, and business news when the context supports it.",
    diversityInstruction,
    "Lead with the sharpest specific fact or implication. Avoid throat-clearing like 'Interesting', 'A reminder', 'In today's world', or 'This shows'.",
    "If using news context, explain the second-order implication: who it affects, what changes, or why builders/investors/operators should care.",
    "Use strong hooks and tasteful tension when useful. Do not use cheap bait, fake claims, hashtags, emojis, em dashes, or generic startup phrases.",
    "Grounding rule: only use facts supplied by the user or source context. If facts are thin, write a narrower observation instead of inventing missing details.",
    "Context engineering rule: pick one angle per candidate. Do not mash together every fact. Make the most relevant detail carry the post.",
    "Write only public-facing post text. Never mention internal labels like SourcePacket, source packet, compact input, candidate, draft, metadata, JSON, prompt, or distillation.",
    "Never mention 'source context', 'grounded facts', or other harness wording.",
    "No incomplete teasers. Every candidate must be a complete standalone post.",
    `Banned phrases: ${bannedPhrases}.`,
    input.tone ? `Account tone: ${input.tone}.` : "Account tone: clear, useful, direct.",
    "At least one candidate should feel like you are sending it to a smart bro: casual, direct, useful, and not cringe.",
    input.objective ? `Account objective: ${input.objective}.` : "Account objective: provide meaningful posts people save, share, and remember.",
    `Hard limit: every candidate must be ${limit} characters or fewer for X free-tier posts and replies.`,
    "The LLM only writes final tweet text. Do not invent sources, browsing results, dates, numbers, quotes, schedules, or strategy.",
    "You may include the source URL when it improves credibility, context, or usefulness and the post still fits the character limit. Do not force links into every candidate.",
    "Do not imply you read more than the provided context.",
    "Keep human control, auditability, local-first operation, and explicit approval visible when relevant.",
    `Return exactly ${count} non-empty candidates.`,
    "Each candidate must be 1-3 short sentences, must directly use the user's rough idea, and must stand alone without thread context.",
    input.context?.facts?.length
      ? "Use only the provided source context and grounded facts. Do not add details that are not present."
      : "",
    'Return strict JSON only with this shape: {"candidates":[{"text":"first draft"},{"text":"second draft"}]}.',
    "Never return an empty candidates array.",
    input.systemPromptExtra ? `Extra user system prompt:\n${input.systemPromptExtra}` : ""
  ].join("\n");
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
    "Never mention SourcePacket, source packet, compact input, candidate, draft, metadata, prompt, or distillation.",
    "Avoid cheap bait, fake claims, hashtags, emojis, and em dashes.",
    "Mention auditability/control/local-first only if it fits the idea."
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
  const texts = parseCandidateTexts(raw, count).filter((text) => text.length <= limit && isCleanTweetText(text));
  if (texts.length === 0) {
    throw new Error(`${provider} returned no draft candidates`);
  }

  return texts.slice(0, count).map((text, index) => ({
    text,
    score: {
      provider,
      model,
      rank: index + 1
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

export * from "./viral-prompt.js";
export * from "./harness.js";
export * from "./viral-generation.js";
