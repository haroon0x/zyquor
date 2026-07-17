import {
  DEFAULT_OPENROUTER_BASE_URL,
  safeOpenRouterModel
} from "../config.js";
import { linePrompt, systemPrompt, userPrompt } from "../prompts.js";
import { asText, candidatesFromText, isNoCandidatesError } from "../quality.js";
import type { DraftGenerationProvider, FetchLike } from "../types.js";
import { getJson, postJson } from "./http.js";

function isZeroPrice(value: unknown) {
  return typeof value === "string" && Number(value) === 0;
}

function assertOpenRouterPricingIsFree(input: {
  model: string;
  pricing?: { completion?: unknown; prompt?: unknown; request?: unknown };
}) {
  if (!input.pricing || !isZeroPrice(input.pricing.prompt) || !isZeroPrice(input.pricing.completion)) {
    throw new Error(`OpenRouter model is not confirmed free: ${input.model}`);
  }
}

export function createOpenRouterGenerationProvider(options: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: FetchLike;
}): DraftGenerationProvider {
  const baseUrl = (options.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const model = safeOpenRouterModel(options.model);
  const fetchImpl = options.fetch ?? fetch;
  let confirmedFree = false;

  async function assertFreeModel() {
    if (confirmedFree) return;
    const body = await getJson<{
      data?: Array<{ id?: unknown; pricing?: { completion?: unknown; prompt?: unknown; request?: unknown } }>;
    }>(fetchImpl, `${baseUrl}/models`, {
      authorization: `Bearer ${options.apiKey}`
    });
    const modelMetadata = body.data?.find((item) => item.id === model);
    assertOpenRouterPricingIsFree({
      model,
      ...(modelMetadata?.pricing ? { pricing: modelMetadata.pricing } : {})
    });
    confirmedFree = true;
  }

  return {
    name: "openrouter",
    model,
    async generateDraftCandidates(input) {
      await assertFreeModel();
      const url = `${baseUrl}/chat/completions`;
      const headers = {
        authorization: `Bearer ${options.apiKey}`,
        "http-referer": "http://127.0.0.1",
        "x-title": "Zyquor"
      };

      try {
        const body = await postJson<{
          choices?: Array<{ message?: { content?: unknown } }>;
        }>(
          fetchImpl,
          url,
          {
            model,
            messages: [
              { role: "system", content: systemPrompt(input) },
              { role: "user", content: userPrompt(input) }
            ],
            response_format: { type: "json_object" },
            temperature: 0.65,
            max_tokens: 900
          },
          headers
        );
        const text = asText(body.choices?.[0]?.message?.content);
        return candidatesFromText(text, input, "openrouter", model);
      } catch (error) {
        if (!isNoCandidatesError(error, "openrouter")) {
          throw error;
        }

        const retryBody = await postJson<{
          choices?: Array<{ message?: { content?: unknown } }>;
        }>(
          fetchImpl,
          url,
          {
            model,
            messages: [{ role: "user", content: linePrompt(input) }],
            temperature: 0.5,
            max_tokens: 500
          },
          headers
        );
        const retryText = asText(retryBody.choices?.[0]?.message?.content);
        return candidatesFromText(retryText, input, "openrouter", model);
      }
    }
  };
}
