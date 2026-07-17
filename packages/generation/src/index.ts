import { resolveGenerationProviderConfig } from "./config.js";
import { createGeminiGenerationProvider } from "./providers/gemini.js";
import { createOllamaGenerationProvider } from "./providers/ollama.js";
import { createOpenRouterGenerationProvider } from "./providers/openrouter.js";
import type { GenerationEnvironment } from "./config.js";
import type { DraftGenerationProvider, FetchLike } from "./types.js";

export type { GenerationEnvironment } from "./config.js";
export {
  GEMINI_MODELS,
  GENERATION_MODEL_OPTIONS,
  OLLAMA_MODELS,
  OPENROUTER_MODELS,
  resolveGenerationProviderConfig
} from "./config.js";
export { createGeminiGenerationProvider } from "./providers/gemini.js";
export { createOllamaGenerationProvider, stripThinking } from "./providers/ollama.js";
export { createOpenRouterGenerationProvider } from "./providers/openrouter.js";
export { isCleanTweetText, postProcessTweetText, scoreTweetQuality } from "./quality.js";
export type {
  DraftGenerationProvider,
  FetchLike,
  GenerateDraftCandidatesInput,
  GeneratedDraftCandidate,
  GenerationProviderConfig,
  GenerationProviderName
} from "./types.js";

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
