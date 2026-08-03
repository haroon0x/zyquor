import type { GenerationEnvironment } from "@zyquor/generation";
import { resolveGenerationProviderConfig } from "@zyquor/generation";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readSavedGenerationEnv(configPath: string | null): GenerationEnvironment {
  if (!configPath) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      model?: unknown;
      provider?: unknown;
    };
    const provider = typeof parsed.provider === "string" ? parsed.provider : undefined;
    const model = typeof parsed.model === "string" ? parsed.model : undefined;

    if (!provider || !model) {
      return {};
    }

    return {
      ZYQUOR_LLM_PROVIDER: provider,
      ...(provider === "command-code" ? { ZYQUOR_COMMAND_CODE_MODEL: model } : {}),
      ...(provider === "codex" ? { ZYQUOR_CODEX_MODEL: model } : {}),
      ...(provider === "gemini" ? { ZYQUOR_GEMINI_MODEL: model } : {}),
      ...(provider === "openrouter" ? { ZYQUOR_OPENROUTER_MODEL: model } : {}),
      ...(provider === "ollama" ? { ZYQUOR_OLLAMA_MODEL: model } : {})
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function writeSavedGenerationEnv(configPath: string | null, env: GenerationEnvironment) {
  if (!configPath) {
    return;
  }

  const config = resolveGenerationProviderConfig(env);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ provider: config.provider, model: config.model }, null, 2)}\n`,
    "utf8"
  );
}
