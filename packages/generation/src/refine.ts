import { linePrompt, systemPrompt, userPrompt } from "./prompts.js";
import { candidatesFromText, isNoCandidatesError } from "./quality.js";
import type { GenerateDraftCandidatesInput, GeneratedDraftCandidate, GenerationProviderName } from "./types.js";

/**
 * Write candidates with a single LLM call.
 *
 * The full anti-slop guidance (voice rules, punctuation, style contract, banned
 * phrases, source boundary) lives in `systemPrompt`/`userPrompt`, so there is no
 * need for separate insight, audit, reader-critique, revise, or repair passes.
 * If the model returns something we cannot parse into candidates, retry once with
 * the simpler `linePrompt` for robustness, then fail loudly.
 */
export async function generateDraftCandidates(input: {
  generationInput: GenerateDraftCandidatesInput;
  model: string;
  providerName: GenerationProviderName;
  runInitial?: (generationInput: GenerateDraftCandidatesInput) => Promise<string>;
  runPrompt: (prompt: string) => Promise<string>;
}): Promise<GeneratedDraftCandidate[]> {
  const generationInput = input.generationInput;
  const initial = input.runInitial
    ? await input.runInitial(generationInput)
    : await input.runPrompt(`${systemPrompt(generationInput)}\n\n${userPrompt(generationInput)}`);

  try {
    return candidatesFromText(initial, generationInput, input.providerName, input.model);
  } catch (error) {
    if (!isNoCandidatesError(error, input.providerName)) throw error;
    const retry = await input.runPrompt(linePrompt(generationInput));
    return candidatesFromText(retry, generationInput, input.providerName, input.model);
  }
}
