import {
  resolveGenerationProviderConfig,
  type EvaluateTweetQualityOptions,
  type GenerationEnvironment
} from "@zyquor/generation";

export function qualityJudgeOptions(env: GenerationEnvironment): EvaluateTweetQualityOptions {
  const config = resolveGenerationProviderConfig({ ...env, ZYQUOR_LLM_PROVIDER: "ollama" });
  return {
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    model: config.model
  };
}
