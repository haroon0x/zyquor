import { resolveGenerationProviderConfig } from "@zyquor/generation";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";

function hasExplicitGenerationConfig(deps: AppDeps) {
  const env = deps.generationEnv;
  return Boolean(
    (env.ZYQUOR_LLM_PROVIDER && env.ZYQUOR_LLM_PROVIDER.toLowerCase() !== "auto") ||
    env.ZYQUOR_OPENROUTER_API_KEY ||
    env.ZYQUOR_OPENROUTER_MODEL ||
    env.ZYQUOR_OPENROUTER_BASE_URL ||
    env.ZYQUOR_GEMINI_API_KEY ||
    env.ZYQUOR_GEMINI_MODEL ||
    env.ZYQUOR_GEMINI_BASE_URL ||
    env.ZYQUOR_OLLAMA_MODEL ||
    env.ZYQUOR_OLLAMA_BASE_URL
  );
}

export function registerOnboardingRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/onboarding/status", async () => {
    const repository = await deps.repository;
    const [accounts, hasDrafts, jobs] = await Promise.all([
      repository.listAccounts(),
      repository.hasDrafts(),
      repository.listJobs()
    ]);
    const generation = resolveGenerationProviderConfig(deps.generationEnv);
    const generationIsDefault = !hasExplicitGenerationConfig(deps);
    const hasJobs = jobs.length > 0;
    const xSessionCheckedOk = deps.onboarding.xSessionCheckedOk;

    return {
      needsOnboarding:
        !hasDrafts &&
        !hasJobs &&
        (!generation.configured || generationIsDefault) &&
        !xSessionCheckedOk,
      accountsCount: accounts.length,
      hasDrafts,
      hasJobs,
      generation: {
        ...generation,
        isDefault: generationIsDefault
      },
      xSessionCheckedOk
    };
  });
}
