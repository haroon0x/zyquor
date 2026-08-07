import { linePrompt, revisionPrompt, systemPrompt, userPrompt } from "./prompts.js";
import { candidatesFromText, isNoCandidatesError } from "./quality.js";
import type { GenerateDraftCandidatesInput, GeneratedDraftCandidate, GenerationProviderName } from "./types.js";

/**
 * Write candidates with a single LLM call, plus an optional revision pass.
 *
 * The full anti-slop guidance (voice rules, punctuation, style contract, banned
 * phrases, source boundary) lives in `systemPrompt`/`userPrompt`, so there is no
 * need for separate insight, audit, reader-critique, or repair passes.
 * `revise` adds one cut-only editing pass on top: it can only remove vagueness
 * and unsupported claims, never add material, and never lowers a candidate's
 * quality score. If the model returns something we cannot parse into candidates,
 * retry once with the simpler `linePrompt` for robustness, then fail loudly.
 */
export async function generateDraftCandidates(input: {
  generationInput: GenerateDraftCandidatesInput;
  model: string;
  providerName: GenerationProviderName;
  runInitial?: (generationInput: GenerateDraftCandidatesInput) => Promise<string>;
  runPrompt: (prompt: string) => Promise<string>;
  revise?: boolean;
}): Promise<GeneratedDraftCandidate[]> {
  const generationInput = input.generationInput;
  const initial = input.runInitial
    ? await input.runInitial(generationInput)
    : await input.runPrompt(`${systemPrompt(generationInput)}\n\n${userPrompt(generationInput)}`);

  let candidates: GeneratedDraftCandidate[];
  try {
    candidates = candidatesFromText(initial, generationInput, input.providerName, input.model);
  } catch (error) {
    if (!isNoCandidatesError(error, input.providerName)) {
      // Provider-level failure (timeout, transport error, empty output): usually a
      // transient fault, so give the full prompt one more attempt before giving up.
      const retry = await input.runPrompt(`${systemPrompt(generationInput)}\n\n${userPrompt(generationInput)}`);
      candidates = candidatesFromText(retry, generationInput, input.providerName, input.model);
    } else {
      // Kept the reply but it gives no usable candidates: retry once with the
      // simpler line prompt, then fail loudly.
      const lineRetry = await input.runPrompt(linePrompt(generationInput));
      candidates = candidatesFromText(lineRetry, generationInput, input.providerName, input.model);
    }
  }

  if (!input.revise || candidates.length === 0) return candidates;

  // Revision is an enhancement, never a failure point: any error falls back to
  // the first-pass drafts, and a revised draft only replaces the original when
  // it survives the same quality pipeline and scores at least as high.
  try {
    const revisedRaw = await input.runPrompt(revisionPrompt(generationInput, candidates.map((candidate) => candidate.text)));
    const revised = candidatesFromText(revisedRaw, generationInput, input.providerName, input.model);
    return candidates.map((original, index) => {
      const better = revised[index];
      if (
        better &&
        better.text !== original.text &&
        Number(better.score?.quality ?? 0) >= Number(original.score?.quality ?? 0)
      ) return better;
      return original;
    });
  } catch {
    return candidates;
  }
}
