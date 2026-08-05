import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from "../config.js";
import { systemPrompt, userPrompt } from "../prompts.js";
import { asText } from "../quality.js";
import { generateDraftCandidates } from "../refine.js";
import type { DraftGenerationProvider, FetchLike } from "../types.js";
import { postJson } from "./http.js";

export function stripThinking(text: string): string {
  let stripped = text.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "").trim();
  while (/^Thinking(?:\.\.\.|…|:)/i.test(stripped)) {
    const contentStart = stripped.search(/(?:^|\r?\n)\s*(?:(?:```(?:json)?\s*)?[\[{]|(?:Draft|Candidate)\s*1\s*:)/i);
    if (contentStart > 0) return stripped.slice(contentStart).trim();

    const withoutSection = stripped.replace(
      /^Thinking(?:\.\.\.|…|:)[^\r\n]*(?:\r?\n(?!\s*$)[^\r\n]*)*\r?\n\s*\r?\n/i,
      ""
    ).trim();
    if (withoutSection === stripped) {
      return stripped.replace(/^Thinking(?:\.\.\.|…|:)[^\r\n]*(?:\r?\n)?/i, "").trim();
    }
    stripped = withoutSection;
  }

  return stripped;
}

export function createOllamaGenerationProvider(options: {
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
} = {}): DraftGenerationProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_OLLAMA_MODEL;
  const fetchImpl = options.fetch ?? fetch;

  return {
    name: "ollama",
    model,
    async generateDraftCandidates(input) {
      const chat = async (messages: Array<{ role: string; content: string }>, numPredict: number) => {
        const body = await postJson<{ message?: { content?: unknown } }>(fetchImpl, `${baseUrl}/api/chat`, {
          model,
          messages,
          stream: false,
          format: "json",
          think: false,
          options: {
            temperature: 0.6,
            num_predict: numPredict
          }
        });
        return stripThinking(asText(body.message?.content));
      };

      return generateDraftCandidates({
        generationInput: input,
        model,
        providerName: "ollama",
        runInitial: (generationInput) =>
          chat(
            [
              { role: "system", content: systemPrompt(generationInput) },
              { role: "user", content: userPrompt(generationInput) }
            ],
            900
          ),
        runPrompt: (prompt) => chat([{ role: "user", content: prompt }], 900)
      });
    }
  };
}
