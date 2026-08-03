import { apiUrl } from "./api-base.js";
import type { Account, GenerationResponse } from "./types.js";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...init?.headers
  };
  const response = await fetch(apiUrl(path), {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export async function loadAppData() {
  const [{ accounts }, generation] = await Promise.all([
    api<{ accounts: Account[] }>("/accounts"),
    api<GenerationResponse>("/generation")
  ]);
  return { accounts, generation };
}

const PROVIDER_LABELS: Record<string, string> = {
  "command-code": "Command Code",
  codex: "Codex",
  gemini: "Gemini",
  ollama: "Ollama",
  openrouter: "OpenRouter"
};

export function providerLabel(provider: string) {
  return PROVIDER_LABELS[provider] ?? provider;
}

export function liveModelLabel(generation: GenerationResponse["generation"] | null) {
  if (!generation) {
    return "Model unavailable";
  }
  return `${providerLabel(generation.provider)} / ${generation.model}`;
}
