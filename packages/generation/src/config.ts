import type { GenerationProviderConfig, GenerationProviderName } from "./types.js";

export interface GenerationEnvironment {
  ZYQUOR_LLM_PROVIDER?: string;
  ZYQUOR_COMMAND_CODE_MODEL?: string;
  ZYQUOR_COMMAND_CODE_PATH?: string;
  ZYQUOR_CODEX_MODEL?: string;
  ZYQUOR_CODEX_PATH?: string;
  ZYQUOR_OPENCODE_MODEL?: string;
  ZYQUOR_OPENCODE_PATH?: string;
  ZYQUOR_OPENCODE_VARIANT?: string;
  ZYQUOR_REVISION_PASS?: string;
  ZYQUOR_GEMINI_API_KEY?: string;
  ZYQUOR_GEMINI_BASE_URL?: string;
  ZYQUOR_GEMINI_MODEL?: string;
  ZYQUOR_OPENROUTER_API_KEY?: string;
  ZYQUOR_OPENROUTER_BASE_URL?: string;
  ZYQUOR_OPENROUTER_MODEL?: string;
  ZYQUOR_OLLAMA_BASE_URL?: string;
  ZYQUOR_OLLAMA_MODEL?: string;
}

export const DEFAULT_COMMAND_CODE_MODEL = "gpt-5.6-luna";
export const COMMAND_CODE_MODELS = [DEFAULT_COMMAND_CODE_MODEL] as const;

export const DEFAULT_OPENCODE_MODEL = "opencode/deepseek-v4.1-flash-free";
export const DEFAULT_OPENCODE_VARIANT = "high";
// Only GLM and DeepSeek free models are allowed (operator preference,
// 2026-10-26): the complete opencode/* free catalog outside these two families
// is intentionally excluded. Entries here are the safeOpencodeModel values
// exposed to the web settings UI as well.
export const OPENCODE_MODELS = [
  "opencode/glm-5.3-flash-free",
  "opencode/deepseek-v4.1-flash-free"
] as const;
export const OPENCODE_VARIANTS = ["low", "high", "max"] as const;

export function safeOpencodeModel(model: string | undefined) {
  if (!model) return DEFAULT_OPENCODE_MODEL;
  if ((OPENCODE_MODELS as readonly string[]).includes(model)) return model;
  console.warn(`generation: Opencode model "${model}" is not on the DeepSeek Flash allowlist; using "${DEFAULT_OPENCODE_MODEL}"`);
  return DEFAULT_OPENCODE_MODEL;
}

export function safeOpencodeVariant(variant: string | undefined) {
  if (!variant) return DEFAULT_OPENCODE_VARIANT;
  if ((OPENCODE_VARIANTS as readonly string[]).includes(variant)) return variant;
  console.warn(`generation: Opencode variant "${variant}" is not supported; using "${DEFAULT_OPENCODE_VARIANT}"`);
  return DEFAULT_OPENCODE_VARIANT;
}

export function safeCommandCodeModel(model: string | undefined) {
  if (!model || model === DEFAULT_COMMAND_CODE_MODEL) return DEFAULT_COMMAND_CODE_MODEL;
  console.warn(`generation: Command Code model "${model}" is not supported; using "${DEFAULT_COMMAND_CODE_MODEL}"`);
  return DEFAULT_COMMAND_CODE_MODEL;
}

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "inclusionai/ling-3.0-flash:free";
export const OPENROUTER_MODELS = [
  "inclusionai/ling-3.0-flash:free",
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "tencent/hy3:free",
  "poolside/laguna-xs-2.1:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
] as const;
const ALLOWED_OPENROUTER_MODELS = OPENROUTER_MODELS;
export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";
export const GEMINI_MODELS = [
  "gemini-3.6-flash",
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
  "command-code": COMMAND_CODE_MODELS,
  opencode: OPENCODE_MODELS,
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

  const revisionPass = ["1", "true", "yes", "on"].includes(String(env.ZYQUOR_REVISION_PASS).trim().toLowerCase());

  if (provider === "command-code") {
    return {
      provider,
      model: safeCommandCodeModel(env.ZYQUOR_COMMAND_CODE_MODEL),
      configured: true
    };
  }

  if (provider === "opencode") {
    return {
      provider,
      model: safeOpencodeModel(env.ZYQUOR_OPENCODE_MODEL),
      configured: true,
      revisionPass
    };
  }

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
