import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { GENERATION_MODEL_OPTIONS, resolveGenerationProviderConfig } from "@zyquor/generation";
import { createGenerationProviderFromEnv } from "@zyquor/generation";
import type { GenerationEnvironment } from "@zyquor/generation";
import { updateGenerationConfigRequestSchema } from "@zyquor/core";
import { writeSavedGenerationEnv } from "../lib/generation.js";

export function registerGenerationRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/generation", async () => ({
    generation: resolveGenerationProviderConfig(deps.generationEnv),
    providers: GENERATION_MODEL_OPTIONS
  }));

  app.patch("/generation", async (request) => {
    const input = updateGenerationConfigRequestSchema.parse(request.body);
    const nextEnv: GenerationEnvironment = {
      ...deps.generationEnv,
      ZYQUOR_LLM_PROVIDER: input.provider,
      ...(input.provider === "command-code" ? { ZYQUOR_COMMAND_CODE_MODEL: input.model } : {}),
      ...(input.provider === "gemini" ? { ZYQUOR_GEMINI_MODEL: input.model } : {}),
      ...(input.provider === "openrouter" ? { ZYQUOR_OPENROUTER_MODEL: input.model } : {}),
      ...(input.provider === "ollama" ? { ZYQUOR_OLLAMA_MODEL: input.model } : {})
    };
    const nextProvider = createGenerationProviderFromEnv(nextEnv);
    deps.generationEnv = nextEnv;
    deps.generationProvider = nextProvider;
    writeSavedGenerationEnv(deps.generationConfigPath, deps.generationEnv);

    return {
      generation: resolveGenerationProviderConfig(deps.generationEnv),
      providers: GENERATION_MODEL_OPTIONS
    };
  });
}
