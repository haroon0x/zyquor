import { DEFAULT_GEMINI_BASE_URL, DEFAULT_GEMINI_MODEL } from "../config.js";
import { systemPrompt, userPrompt } from "../prompts.js";
import { asText } from "../quality.js";
import { generateWithQualityLoop } from "../refine.js";
import type { DraftGenerationProvider, FetchLike } from "../types.js";
import { postJson } from "./http.js";

export function createGeminiGenerationProvider(options: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
}): DraftGenerationProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_GEMINI_MODEL;
  const fetchImpl = options.fetch ?? fetch;

  return {
    name: "gemini",
    model,
    async generateDraftCandidates(input) {
      const generate = async (prompt: string, system?: string) => {
        const body = await postJson<{
          candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
        }>(fetchImpl, `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(options.apiKey)}`, {
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.65,
            maxOutputTokens: 900
          }
        });
        return asText(body.candidates?.[0]?.content?.parts?.map((part) => asText(part.text)).join("\n"));
      };

      return generateWithQualityLoop({
        generationInput: input,
        model,
        providerName: "gemini",
        runInitial: () => generate(userPrompt(input), systemPrompt(input)),
        runPrompt: (prompt) => generate(prompt)
      });
    }
  };
}
