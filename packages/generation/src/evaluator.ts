import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from "./config.js";
import { postJson } from "./providers/http.js";
import { stripThinking } from "./providers/ollama.js";
import type { FetchLike } from "./types.js";

export interface EvaluateTweetQualityInput {
  text: string;
  tweetType?: string;
  idea?: string;
}

export interface EvaluateTweetQualityOptions {
  baseUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
}

export interface TweetQualityEvaluation {
  score: number;
  verdict: "strong" | "ok" | "weak";
  reasons: string[];
}

export type TweetQualityEvaluator = (
  input: EvaluateTweetQualityInput,
  options?: EvaluateTweetQualityOptions
) => Promise<TweetQualityEvaluation>;

const JUDGE_PROMPT =
  "Judge the tweet for specificity, hook strength, natural voice, and absence of AI slop. Return ONLY JSON matching {\"score\":8,\"verdict\":\"strong\",\"reasons\":[\"specific detail\",\"clear hook\"]}. Use a score from 1 to 10, verdict strong, ok, or weak, and at most 3 short reasons.";

function asJudgeObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Ollama quality judge returned invalid JSON");
  }
  return value as Record<string, unknown>;
}

function parseJudgeJson(content: string): Record<string, unknown> {
  const stripped = stripThinking(content).trim();
  const withoutFence = stripped.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  try {
    return asJudgeObject(JSON.parse(withoutFence));
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return asJudgeObject(JSON.parse(withoutFence.slice(start, end + 1)));
      } catch {
        throw new Error("Ollama quality judge returned invalid JSON");
      }
    }
    throw new Error("Ollama quality judge returned invalid JSON");
  }
}

function verdictForScore(score: number): TweetQualityEvaluation["verdict"] {
  if (score >= 7) return "strong";
  if (score >= 4) return "ok";
  return "weak";
}

export async function evaluateTweetQuality(
  input: EvaluateTweetQualityInput,
  options: EvaluateTweetQualityOptions = {}
): Promise<TweetQualityEvaluation> {
  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_OLLAMA_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const body = await postJson<{ message?: { content?: unknown } }>(fetchImpl, `${baseUrl}/api/chat`, {
    model,
    messages: [
      { role: "system", content: JUDGE_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          text: input.text,
          ...(input.tweetType ? { tweetType: input.tweetType } : {}),
          ...(input.idea ? { idea: input.idea } : {})
        })
      }
    ],
    stream: false,
    format: "json",
    think: false,
    options: {
      temperature: 0,
      num_predict: 200
    }
  });
  const content = typeof body.message?.content === "string" ? body.message.content : "";
  const parsed = parseJudgeJson(content);
  const numericScore = typeof parsed.score === "number" || typeof parsed.score === "string" ? Number(parsed.score) : NaN;
  if (!Number.isFinite(numericScore)) {
    throw new Error("Ollama quality judge returned an invalid score");
  }
  const score = Math.min(10, Math.max(1, numericScore));
  const verdict = parsed.verdict === "strong" || parsed.verdict === "ok" || parsed.verdict === "weak"
    ? parsed.verdict
    : verdictForScore(score);
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons
        .filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0)
        .slice(0, 3)
        .map((reason) => reason.trim().slice(0, 160))
    : [];

  return { score, verdict, reasons };
}
