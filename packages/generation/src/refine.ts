import { auditPrompt, readerCritiquePrompt, readerRevisePrompt, repairPrompt, systemPrompt, userPrompt } from "./prompts.js";
import { candidatesFromText, isNoCandidatesError, normalizeCount, parseCandidateTexts } from "./quality.js";
import type { GenerateDraftCandidatesInput, GenerationProviderName } from "./types.js";

export interface ReaderVerdict {
  n: number;
  verdict: "keep" | "revise" | "drop";
  why?: string;
  fix?: string;
}

export function parseReaderCritique(raw: string): ReaderVerdict[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  let parsed: { critique?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as { critique?: unknown };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.critique)) return [];

  return parsed.critique
    .map((entry, index) => {
      const item = entry as Record<string, unknown>;
      const verdict = item.verdict === "keep" || item.verdict === "revise" || item.verdict === "drop"
        ? item.verdict
        : null;
      if (!verdict) return null;
      const n = Number(item.n);
      return {
        n: Number.isFinite(n) ? n : index + 1,
        verdict,
        ...(typeof item.why === "string" ? { why: item.why.slice(0, 200) } : {}),
        ...(typeof item.fix === "string" ? { fix: item.fix.slice(0, 200) } : {})
      } satisfies ReaderVerdict;
    })
    .filter((entry): entry is ReaderVerdict => entry !== null);
}

export function needsReaderRevision(verdicts: ReaderVerdict[]) {
  return verdicts.some((entry) => entry.verdict !== "keep");
}

function formatCritique(verdicts: ReaderVerdict[]) {
  return verdicts
    .map((entry) => `${entry.n}. ${entry.verdict}${entry.why ? `: ${entry.why}` : ""}${entry.fix ? ` | fix: ${entry.fix}` : ""}`)
    .join("\n");
}

export const READER_REJECTED_ALL = "reader-critique-rejected-all";

function dropRejectedCandidates(candidateOutput: string, verdicts: ReaderVerdict[], count: number) {
  const texts = parseCandidateTexts(candidateOutput, count * 2);
  if (texts.length === 0) return candidateOutput;
  const dropped = new Set(verdicts.filter((entry) => entry.verdict === "drop").map((entry) => entry.n));
  const kept = texts.filter((_text, index) => !dropped.has(index + 1));
  if (kept.length === 0) return READER_REJECTED_ALL;
  if (kept.length === texts.length) return candidateOutput;
  return JSON.stringify({ candidates: kept.map((text) => ({ text })) });
}

export async function applyReaderCritique(input: {
  candidateOutput: string;
  generationInput: GenerateDraftCandidatesInput;
  runPrompt: (prompt: string) => Promise<string>;
}): Promise<string> {
  const count = normalizeCount(input.generationInput.count);
  const critiqueRaw = await input.runPrompt(readerCritiquePrompt(input.generationInput, input.candidateOutput));
  const verdicts = parseReaderCritique(critiqueRaw);
  if (verdicts.length === 0 || !needsReaderRevision(verdicts)) {
    return input.candidateOutput;
  }

  const revised = await input.runPrompt(
    readerRevisePrompt(input.generationInput, input.candidateOutput, formatCritique(verdicts))
  );
  const finalVerdicts = parseReaderCritique(
    await input.runPrompt(readerCritiquePrompt(input.generationInput, revised))
  );
  if (finalVerdicts.length === 0) return revised;

  return dropRejectedCandidates(revised, finalVerdicts, count);
}

export async function generateWithQualityLoop(input: {
  generationInput: GenerateDraftCandidatesInput;
  model: string;
  providerName: GenerationProviderName;
  runInitial?: (() => Promise<string>) | undefined;
  runPrompt: (prompt: string) => Promise<string>;
}) {
  const { generationInput, model, providerName, runPrompt } = input;
  const raw = input.runInitial
    ? await input.runInitial()
    : await runPrompt(`${systemPrompt(generationInput)}\n\n${userPrompt(generationInput)}`);
  const auditedRaw = await runPrompt(auditPrompt(generationInput, raw));
  const readerRaw = await applyReaderCritique({
    candidateOutput: auditedRaw,
    generationInput,
    runPrompt
  });
  if (readerRaw === READER_REJECTED_ALL) {
    throw new Error(`${providerName} returned no draft candidates`);
  }

  try {
    return candidatesFromText(readerRaw, generationInput, providerName, model);
  } catch (error) {
    if (!isNoCandidatesError(error, providerName)) throw error;
    try {
      return candidatesFromText(auditedRaw, generationInput, providerName, model);
    } catch (auditError) {
      if (!isNoCandidatesError(auditError, providerName)) throw auditError;
      const retryRaw = await runPrompt(repairPrompt(generationInput, readerRaw));
      return candidatesFromText(retryRaw, generationInput, providerName, model);
    }
  }
}
