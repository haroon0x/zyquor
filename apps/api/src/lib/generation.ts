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
      revisionPass?: unknown;
    };
    const provider = typeof parsed.provider === "string" ? parsed.provider : undefined;
    const model = typeof parsed.model === "string" ? parsed.model : undefined;

    if (!provider || !model) {
      return {};
    }

    const revisionPass = ["1", "true", "yes", "on"].includes(String(parsed.revisionPass).trim().toLowerCase());

    return {
      ZYQUOR_LLM_PROVIDER: provider,
      ...(revisionPass ? { ZYQUOR_REVISION_PASS: "1" } : {}),
      ...(provider === "command-code" ? { ZYQUOR_COMMAND_CODE_MODEL: model } : {}),
      ...(provider === "opencode" ? { ZYQUOR_OPENCODE_MODEL: model } : {}),
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
    `${JSON.stringify(
      { provider: config.provider, model: config.model, revisionPass: config.revisionPass ? "1" : "0" },
      null,
      2
    )}\n`,
    "utf8"
  );
}
