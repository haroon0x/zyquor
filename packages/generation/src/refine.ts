import { auditPrompt, insightPrompt, readerCritiquePrompt, readerRevisePrompt, repairPrompt, systemPrompt, userPrompt } from "./prompts.js";
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

function parseInsight(raw: string) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return "";

  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { insight?: unknown };
    const insight = typeof parsed.insight === "string" ? parsed.insight.trim().replace(/\s+/g, " ") : "";
    if (insight.length < 30 || insight.split(/\s+/).length < 7) return "";
    return insight.slice(0, 320);
  } catch {
    return "";
  }
}

function critiqueCoversCandidates(candidateOutput: string, verdicts: ReaderVerdict[], count: number) {
  const candidateCount = parseCandidateTexts(candidateOutput, count * 2).length;
  if (candidateCount === 0 || verdicts.length !== candidateCount) return false;
  const numbers = new Set(verdicts.map((entry) => entry.n));
  return numbers.size === candidateCount && [...numbers].every((number) => number >= 1 && number <= candidateCount);
}

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
  strict?: boolean;
  runPrompt: (prompt: string) => Promise<string>;
}): Promise<string> {
  const count = normalizeCount(input.generationInput.count);
  const critiqueRaw = await input.runPrompt(readerCritiquePrompt(input.candidateOutput, input.generationInput.tweetType));
  const verdicts = parseReaderCritique(critiqueRaw);
  if (input.strict) {
    if (!critiqueCoversCandidates(input.candidateOutput, verdicts, count)) return input.candidateOutput;
  } else if (verdicts.length === 0 || !needsReaderRevision(verdicts)) {
    return input.candidateOutput;
  }
  if (!needsReaderRevision(verdicts)) return input.candidateOutput;

  const revised = await input.runPrompt(
    readerRevisePrompt(input.generationInput, input.candidateOutput, formatCritique(verdicts))
  );
  const finalVerdicts = parseReaderCritique(
    await input.runPrompt(readerCritiquePrompt(revised, input.generationInput.tweetType))
  );
  if (input.strict) {
    if (!critiqueCoversCandidates(revised, finalVerdicts, count)) return input.candidateOutput;
  } else if (finalVerdicts.length === 0) {
    return revised;
  }

  return dropRejectedCandidates(revised, finalVerdicts, count);
}

export async function generateWithQualityLoop(input: {
  generationInput: GenerateDraftCandidatesInput;
  model: string;
  providerName: GenerationProviderName;
  runInitial?: ((generationInput: GenerateDraftCandidatesInput) => Promise<string>) | undefined;
  runPrompt: (prompt: string) => Promise<string>;
}) {
  const { model, providerName, runPrompt } = input;
  const insight = input.generationInput.insightRequired
    ? parseInsight(await runPrompt(insightPrompt(input.generationInput)))
    : "";
  if (input.generationInput.insightRequired && input.generationInput.tweetType === "feed_observation" && !insight) {
    throw new Error(`${providerName} returned no draft candidates`);
  }
  const generationInput = insight ? { ...input.generationInput, insight } : input.generationInput;
  const raw = input.runInitial
    ? await input.runInitial(generationInput)
    : await runPrompt(`${systemPrompt(generationInput)}\n\n${userPrompt(generationInput)}`);
  const auditedRaw = await runPrompt(auditPrompt(generationInput, raw));
  const readerRaw = await applyReaderCritique({
    candidateOutput: auditedRaw,
    generationInput,
    strict: providerName === "codex" || providerName === "command-code",
    runPrompt
  });
  if (readerRaw === READER_REJECTED_ALL) {
    throw new Error(`${providerName} returned no draft candidates`);
  }

  const strictReview = providerName === "codex" || providerName === "command-code";
  const finalRaw = !strictReview || readerRaw === auditedRaw
    ? readerRaw
    : await runPrompt(auditPrompt(generationInput, readerRaw));

  try {
    return candidatesFromText(finalRaw, generationInput, providerName, model);
  } catch (error) {
    if (!isNoCandidatesError(error, providerName)) throw error;
    if (strictReview && readerRaw !== auditedRaw) throw error;
    try {
      return candidatesFromText(auditedRaw, generationInput, providerName, model);
    } catch (auditError) {
      if (!isNoCandidatesError(auditError, providerName)) throw auditError;
      const retryRaw = await runPrompt(repairPrompt(generationInput, finalRaw));
      return candidatesFromText(retryRaw, generationInput, providerName, model);
    }
  }
}
