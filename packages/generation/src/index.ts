export type GenerationProviderName = "mock" | "ollama" | "gemini";

export interface GenerateDraftCandidatesInput {
  idea: string;
  count?: number;
}

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

export function generateMockDraftCandidates(input: GenerateDraftCandidatesInput): GeneratedDraftCandidate[] {
  const count = normalizeCount(input.count);
  const base = normalizeIdea(input.idea);
  const variants = [
    `${base}\n\nThe hidden cost is not the tooling. It is losing the audit trail between idea, draft, approval, and action.`,
    `${base}\n\nGood local tools should make every step inspectable: what changed, who approved it, and what happened in the browser.`,
    `${base}\n\nThe best automation still keeps the final human decision visible. Draft faster, review clearly, act deliberately.`,
    `${base}\n\nWhen software touches a public account, invisible state is the risk. Make profiles, approvals, and attempts explicit.`,
    `${base}\n\nSpeed matters, but traceability matters more. A posting assistant should remove copy-paste without removing control.`
  ];

  return variants.slice(0, count).map((text, index) => ({
    text,
    score: { provider: "mock", rank: index + 1 }
  }));
}

function systemPrompt(count: number) {
  return [
    "You are Zyquor's draft generator for X posts.",
    "Write concrete, concise, review-ready draft candidates.",
    "Do not use hype, clickbait, hashtags, emojis, engagement bait, or generic startup phrases.",
    "Keep human control, auditability, local-first operation, and explicit approval visible when relevant.",
    `Return exactly ${count} non-empty candidates.`,
    "Each candidate must be 1-3 short sentences and must directly use the user's rough idea.",
    'Return strict JSON only with this shape: {"candidates":[{"text":"first draft"},{"text":"second draft"}]}.',
    "Never return an empty candidates array."
  ].join("\n");
}

function userPrompt(input: GenerateDraftCandidatesInput) {
  return `Rough idea:\n${normalizeIdea(input.idea)}`;
}

function linePrompt(input: GenerateDraftCandidatesInput) {
  const count = normalizeCount(input.count);
  return [
    `Write exactly ${count} concise X post drafts about this idea: ${normalizeIdea(input.idea)}`,
    "One draft per line.",
    "No numbering, no labels, no JSON.",
    "Avoid hype, hashtags, emojis, and engagement bait.",
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
  const texts = parseCandidateTexts(raw, count);
  if (texts.length === 0) {
    throw new Error(`${provider} returned no draft candidates`);
  }
  const fallbackTexts = generateMockDraftCandidates(input)
    .map((candidate) => candidate.text)
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
          system: systemPrompt(count),
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
            parts: [{ text: systemPrompt(count) }]
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
