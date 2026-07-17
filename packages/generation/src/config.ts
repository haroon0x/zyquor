import type { GenerationProviderConfig, GenerationProviderName } from "./types.js";

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

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-26b-a4b-it:free";
export const OPENROUTER_MODELS = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "tencent/hy3:free",
  "poolside/laguna-xs-2.1:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
] as const;
const ALLOWED_OPENROUTER_MODELS = OPENROUTER_MODELS;
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
export const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-1.5-flash"
] as const;
export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "gemma4:e4b";
export const OLLAMA_MODELS = [
  "gemma4:e4b",
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

export function safeOpenRouterModel(model: string | undefined) {
  if (!model) return DEFAULT_OPENROUTER_MODEL;
  if ((ALLOWED_OPENROUTER_MODELS as readonly string[]).includes(model)) return model;
  console.warn(`generation: OpenRouter model "${model}" is not in the free allowlist; using "${DEFAULT_OPENROUTER_MODEL}"`);
  return DEFAULT_OPENROUTER_MODEL;
}

export function resolveGenerationProviderConfig(env: GenerationEnvironment = process.env): GenerationProviderConfig {
  const requestedProvider = (env.ZYQUOR_LLM_PROVIDER ?? "auto").toLowerCase();
  const provider = (
    requestedProvider === "auto"
      ? env.ZYQUOR_OPENROUTER_API_KEY
        ? "openrouter"
        : env.ZYQUOR_GEMINI_API_KEY
          ? "gemini"
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
