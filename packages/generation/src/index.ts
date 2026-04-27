export type GenerationProviderName = "mock" | "ollama" | "gemini";

export interface GenerateDraftCandidatesInput {
  bannedPhrases?: string[];
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
  ZYQUOR_OLLAMA_BASE_URL?: string;
  ZYQUOR_OLLAMA_MODEL?: string;
  ZYQUOR_GEMINI_API_KEY?: string;
  ZYQUOR_GEMINI_MODEL?: string;
}

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.1";
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

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

export function generateMockDraftCandidates(input: GenerateDraftCandidatesInput): GeneratedDraftCandidate[] {
  const count = normalizeCount(input.count);
  const base = normalizeIdea(input.idea);
  const prefix = input.tweetType ? `[${input.tweetType}] ` : "";
  const variants = [
    `${prefix}${base}\n\nThe useful part is the audit trail: idea, draft, approval, schedule, and browser action all stay visible.`,
    `${prefix}${base}\n\nGood automation removes repetitive work without hiding decisions. Keep inputs, rules, timing, and outcomes inspectable.`,
    `${prefix}${base}\n\nThe best systems automate the boring parts and leave judgment visible: choose the source, review the draft, then schedule deliberately.`,
    `${prefix}${base}\n\nWhen software touches a public account, invisible state is the risk. Make profiles, approvals, schedules, and attempts explicit.`,
    `${prefix}${base}\n\nSpeed helps, but traceability compounds. A posting assistant should reduce copy-paste without reducing control.`
  ];

  return variants.slice(0, count).map((text, index) => ({
    text,
    score: { provider: "mock", rank: index + 1 }
  }));
}

function systemPrompt(input: GenerateDraftCandidatesInput) {
  const count = normalizeCount(input.count);
  const bannedPhrases = input.bannedPhrases?.length ? input.bannedPhrases.join(", ") : "game changer, unlock, 10x";
  const limit = characterLimit(input);
  return [
    "You are Zyquor's draft generator for X posts.",
    "Write concrete, concise, review-ready draft candidates.",
    "Objective: maximize useful reach, views, and reputation by being specific, timely, clear, and valuable.",
    "Use strong hooks and tasteful tension when useful. Do not use cheap bait, fake claims, hashtags, emojis, em dashes, or generic startup phrases.",
    `Banned phrases: ${bannedPhrases}.`,
    input.tone ? `Account tone: ${input.tone}.` : "Account tone: clear, useful, direct.",
    input.objective ? `Account objective: ${input.objective}.` : "Account objective: provide meaningful posts people save, share, and remember.",
    `Hard limit: every candidate must be ${limit} characters or fewer for X free-tier posts and replies.`,
    "The LLM only writes candidate tweet text. Do not invent sources, browsing results, schedules, or strategy.",
    "Keep human control, auditability, local-first operation, and explicit approval visible when relevant.",
    `Return exactly ${count} non-empty candidates.`,
    "Each candidate must be 1-3 short sentences and must directly use the user's rough idea.",
    'Return strict JSON only with this shape: {"candidates":[{"text":"first draft"},{"text":"second draft"}]}.',
    "Never return an empty candidates array.",
    input.systemPromptExtra ? `Extra user system prompt:\n${input.systemPromptExtra}` : ""
  ].join("\n");
}

function userPrompt(input: GenerateDraftCandidatesInput) {
  return `${tweetTypeInstruction(input.tweetType)}\n\nCompact input:\n${normalizeIdea(input.idea)}`;
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
  const texts = parseCandidateTexts(raw, count).filter((text) => text.length <= limit);
  if (texts.length === 0) {
    throw new Error(`${provider} returned no draft candidates`);
  }
  const fallbackTexts = generateMockDraftCandidates(input)
    .map((candidate) => candidate.text)
    .filter((text) => text.length <= limit)
    .filter((text) => !texts.includes(text));
  const paddedTexts = [...texts, ...fallbackTexts].slice(0, count);

  return paddedTexts.map((text, index) => ({
    text,
    score: {
      provider,
      model,
      rank: index + 1,
      ...(index >= texts.length ? { fallbackReason: "provider_returned_too_few_candidates" } : {})
    }
  }));
}

function isNoCandidatesError(error: unknown, provider: GenerationProviderName) {
  return error instanceof Error && error.message === `${provider} returned no draft candidates`;
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

export function createMockGenerationProvider(): DraftGenerationProvider {
  return {
    name: "mock",
    model: "mock",
    async generateDraftCandidates(input) {
      return generateMockDraftCandidates(input);
    }
  };
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

export function createGeminiGenerationProvider(options: {
  apiKey: string;
  model?: string;
  fetch?: FetchLike;
}): DraftGenerationProvider {
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const fetchImpl = options.fetch ?? fetch;

  return {
    name: "gemini",
    model,
    async generateDraftCandidates(input) {
      const count = normalizeCount(input.count);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const body = await postJson<{
        candidates?: Array<{ content?: { parts?: Array<{ text?: unknown; thought?: unknown }> } }>;
      }>(
        fetchImpl,
        url,
        {
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
            temperature: 0.7,
            maxOutputTokens: 900
          }
        },
        { "x-goog-api-key": options.apiKey }
      );

      const text = asText(
        body.candidates?.[0]?.content?.parts
          ?.filter((part) => part.thought !== true)
          .map((part) => asText(part.text))
          .join("")
      );
      return candidatesFromText(text, input, "gemini", model);
    }
  };
}

export function resolveGenerationProviderConfig(env: GenerationEnvironment = process.env): GenerationProviderConfig {
  const provider = (env.ZYQUOR_LLM_PROVIDER ?? "mock").toLowerCase() as GenerationProviderName;

  if (provider === "mock") {
    return { provider, model: "mock", configured: true };
  }

  if (provider === "ollama") {
    return {
      provider,
      model: env.ZYQUOR_OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL,
      baseUrl: env.ZYQUOR_OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
      configured: true
    };
  }

  if (provider === "gemini") {
    return {
      provider,
      model: env.ZYQUOR_GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL,
      configured: Boolean(env.ZYQUOR_GEMINI_API_KEY)
    };
  }

  throw new Error(`Unsupported LLM provider: ${provider}`);
}

export function createGenerationProviderFromEnv(
  env: GenerationEnvironment = process.env,
  fetchImpl: FetchLike = fetch
): DraftGenerationProvider {
  const config = resolveGenerationProviderConfig(env);

  if (config.provider === "mock") {
    return createMockGenerationProvider();
  }

  if (config.provider === "ollama") {
    return createOllamaGenerationProvider({
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      model: config.model,
      fetch: fetchImpl
    });
  }

  if (!env.ZYQUOR_GEMINI_API_KEY) {
    throw new Error("ZYQUOR_GEMINI_API_KEY is required when ZYQUOR_LLM_PROVIDER=gemini");
  }

  return createGeminiGenerationProvider({
    apiKey: env.ZYQUOR_GEMINI_API_KEY,
    model: config.model,
    fetch: fetchImpl
  });
}
