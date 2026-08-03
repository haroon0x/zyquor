import { resolveGenerationProviderConfig } from "./config.js";
import { createGeminiGenerationProvider } from "./providers/gemini.js";
import { createCommandCodeGenerationProvider } from "./providers/command-code.js";
import { createCodexGenerationProvider } from "./providers/codex.js";
import { createOllamaGenerationProvider } from "./providers/ollama.js";
import { createOpenRouterGenerationProvider } from "./providers/openrouter.js";
import type { GenerationEnvironment } from "./config.js";
import type { DraftGenerationProvider, FetchLike } from "./types.js";

export type { GenerationEnvironment } from "./config.js";
export {
  COMMAND_CODE_MODELS,
  CODEX_MODELS,
  DEFAULT_CODEX_MODEL,
  GEMINI_MODELS,
  GENERATION_MODEL_OPTIONS,
  OLLAMA_MODELS,
  OPENROUTER_MODELS,
  resolveGenerationProviderConfig
} from "./config.js";
export { createCommandCodeGenerationProvider } from "./providers/command-code.js";
export { createCodexGenerationProvider } from "./providers/codex.js";
export { createGeminiGenerationProvider } from "./providers/gemini.js";
export { createOllamaGenerationProvider, stripThinking } from "./providers/ollama.js";
export { createOpenRouterGenerationProvider } from "./providers/openrouter.js";
export { evaluateTweetQuality } from "./evaluator.js";
export {
  DEFAULT_QUALITY_MIN,
  isCleanTweetText,
  passesTweetQualityFloor,
  postProcessTweetText,
  qualityMinimum,
  scoreTweetQuality
} from "./quality.js";
export { applyReaderCritique, parseReaderCritique, READER_REJECTED_ALL } from "./refine.js";
export type { ReaderVerdict } from "./refine.js";
export type {
  DraftGenerationProvider,
  FetchLike,
  GenerateDraftCandidatesInput,
  GeneratedDraftCandidate,
  GenerationProviderConfig,
  GenerationProviderName
} from "./types.js";
export type {
  EvaluateTweetQualityInput,
  EvaluateTweetQualityOptions,
  TweetQualityEvaluation,
  TweetQualityEvaluator
} from "./evaluator.js";

export function createGenerationProviderFromEnv(
  env: GenerationEnvironment = process.env,
  fetchImpl: FetchLike = fetch
): DraftGenerationProvider {
  const config = resolveGenerationProviderConfig(env);

  if (config.provider === "command-code") {
    return createCommandCodeGenerationProvider({
      ...(env.ZYQUOR_COMMAND_CODE_PATH ? { command: env.ZYQUOR_COMMAND_CODE_PATH } : {}),
      model: config.model
    });
  }

  if (config.provider === "codex") {
    return createCodexGenerationProvider({
      ...(env.ZYQUOR_CODEX_PATH ? { command: env.ZYQUOR_CODEX_PATH } : {}),
      model: config.model
    });
  }

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
