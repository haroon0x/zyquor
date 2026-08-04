import {
  resolveGenerationProviderConfig,
  type EvaluateTweetQualityInput,
  type EvaluateTweetQualityOptions,
  type GenerationEnvironment,
  type TweetQualityEvaluation,
  type TweetQualityEvaluator
} from "@zyquor/generation";

export function qualityJudgeOptions(env: GenerationEnvironment): EvaluateTweetQualityOptions {
  const config = resolveGenerationProviderConfig(env);
  return {
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    model: config.model
  };
}

export interface QualityJudgeResult {
  unavailable: boolean;
  error?: string;
  evaluations?: TweetQualityEvaluation[];
}

export async function runQualityJudge(
  evaluator: TweetQualityEvaluator,
  inputs: EvaluateTweetQualityInput[],
  options: EvaluateTweetQualityOptions
): Promise<QualityJudgeResult> {
  try {
    const evaluations: TweetQualityEvaluation[] = [];
    for (const input of inputs) {
      evaluations.push(await evaluator(input, options));
    }
    return { unavailable: false, evaluations };
  } catch (error) {
    return { unavailable: true, error: error instanceof Error ? error.message : String(error) };
  }
}
