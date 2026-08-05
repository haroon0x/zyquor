import {
  DEFAULT_OPENROUTER_BASE_URL,
  safeOpenRouterModel
} from "../config.js";
import { linePrompt, systemPrompt, userPrompt } from "../prompts.js";
import { asText, candidatesFromText, isNoCandidatesError } from "../quality.js";
import { generateWithQualityLoop } from "../refine.js";
import type { DraftGenerationProvider, FetchLike } from "../types.js";
import { getJson, postJson } from "./http.js";

function isZeroPrice(value: unknown) {
  return (typeof value === "string" || typeof value === "number") && Number(value) === 0;
}

function assertOpenRouterPricingIsFree(input: {
  model: string;
  pricing?: { completion?: unknown; prompt?: unknown; request?: unknown };
}) {
  if (
    !input.pricing ||
    !isZeroPrice(input.pricing.prompt) ||
    !isZeroPrice(input.pricing.completion) ||
    (input.pricing.request !== undefined && !isZeroPrice(input.pricing.request))
  ) {
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
  let supportsJsonFormat = model !== "inclusionai/ling-3.0-flash:free";

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
        authorization: `Bearer ${options.apiKey}`
      };

      const send = (messages: Array<{ role: string; content: string }>, withJsonFormat: boolean) =>
        postJson<{ choices?: Array<{ message?: { content?: unknown } }> }>(
          fetchImpl,
          url,
          {
            model,
            messages,
            ...(withJsonFormat ? { response_format: { type: "json_object" } } : {}),
            temperature: 0.65,
            max_tokens: 900
          },
          headers
        );

      const chat = async (messages: Array<{ role: string; content: string }>) => {
        try {
          return asText((await send(messages, supportsJsonFormat)).choices?.[0]?.message?.content);
        } catch (error) {
          // Not every free model supports structured outputs. Fall back once and
          // remember, instead of failing every item in the run.
          if (!supportsJsonFormat || !/structured-outputs|response_format/i.test(String((error as Error).message))) {
            throw error;
          }
          supportsJsonFormat = false;
          return asText((await send(messages, false)).choices?.[0]?.message?.content);
        }
      };

      try {
        return await generateWithQualityLoop({
          generationInput: input,
          model,
          providerName: "openrouter",
          runInitial: (generationInput) =>
            chat([
              { role: "system", content: systemPrompt(generationInput) },
              { role: "user", content: userPrompt(generationInput) }
            ]),
          runPrompt: (prompt) => chat([{ role: "user", content: prompt }])
        });
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
