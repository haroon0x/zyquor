import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  createGenerationProviderFromEnv,
  isCleanTweetText,
  passesTweetQualityFloor,
  qualityMinimum,
  resolveGenerationProviderConfig,
  scoreTweetQuality
} from "../packages/generation/dist/index.js";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const cases = [
  {
    name: "arxiv-replay",
    tweetType: "article_summary",
    idea: "Title: Deterministic Replay for AI Agent Systems\nURL: https://arxiv.org/abs/2607.16200\nSummary: agent systems that couple LLMs with external tools are non-deterministic because of LLM sampling variance, external API state, CDN infrastructure headers, and execution-environment noise.\nFacts:\n- existing observability platforms capture execution logs but cannot reproduce a run in isolation\n- agrepl is a developer-first CLI framework for deterministic replay"
  },
  {
    name: "show-hn-index",
    tweetType: "article_summary",
    idea: "Title: Show HN: Ex Situ, open-source spatial index of displaced cultural artifacts\nURL: https://exsitu.app/map\nSummary: a spatial index that maps museum artefacts as arcs from origin site to holding institution.\nFacts:\n- AGPL-3.0, Next.js + Deck.gl frontend, Strapi backend, Python ETL over museum open-access APIs\n- indexes over 100k artifacts across 8 collections including the Met, V&A, SMB Berlin\n- started as an MA thesis in 2022, built mostly solo"
  },
  {
    name: "release-note",
    tweetType: "news_context",
    idea: "Title: Zed 1.0 released\nSummary: the editor reached a stable release after years of work on collaboration, speed, and native performance.\nFacts:\n- 1.0 is the first stable release\n- focus areas were collaboration, speed, native performance"
  },
  {
    name: "ops-lesson",
    tweetType: "lesson",
    idea: "We moved a low-traffic internal service off Kubernetes onto a single Docker host. Facts: the service does not need autoscaling, multi-region routing, or fast node replacement; the migration removed cluster upgrades, RBAC config, and scheduler debugging from the on-call load."
  },
  {
    name: "tool-note",
    tweetType: "tool",
    idea: "ripgrep is used for repository-wide text search. Facts: it searches large repositories quickly; it matches text, not symbols, so it cannot distinguish a definition from a mention."
  }
];

const JUDGE_RUBRIC = `You are an independent judge grading public X posts against a high editorial bar. Judge each post only against the input context shown with it. Do not add facts from memory. For each numbered post return JSON only:
{"posts":[{"n":1,"score":7,"verdict":"strong|ok|weak","fault":"one short phrase","fix":"one short instruction"}]}
Score 1-10 on: does it carry one useful thought rather than a source recap, is the anchor concrete, is the payoff supported by the input, does it read like a person rather than a model, and is the opener earned. 8-10 means you would post it from your own account. 5-7 means it needs revision. 1-4 means it should be rejected. Be strict: a fluent recap or unsupported claim is a 4 or lower.`;

function runCommandCode(prompt, model) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("ZYQUOR_")) env[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ZYQUOR_COMMAND_CODE_PATH || "command-code", [
      "--skip-onboarding",
      "--permission-mode",
      "plan",
      "--model",
      model,
      "--print"
    ], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8").trim());
      else reject(new Error(Buffer.concat(err).toString("utf8").trim().slice(0, 500)));
    });
    child.stdin.end(prompt);
  });
}

function judgeVerdict(score) {
  if (score >= 8) return "strong";
  if (score >= 5) return "ok";
  return "weak";
}

function parseJudge(raw, max) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed?.posts)) return [];
  const seen = new Set();
  return parsed.posts.flatMap((post) => {
    const n = Number(post?.n);
    const score = Number(post?.score);
    if (!Number.isInteger(n) || n < 1 || n > max || seen.has(n) || !Number.isFinite(score)) return [];
    seen.add(n);
    const normalizedScore = Math.min(10, Math.max(1, Math.round(score)));
    return [{
      n,
      score: normalizedScore,
      verdict: judgeVerdict(normalizedScore),
      ...(typeof post?.fault === "string" ? { fault: post.fault.trim().slice(0, 160) } : {}),
      ...(typeof post?.fix === "string" ? { fix: post.fix.trim().slice(0, 160) } : {})
    }];
  });
}

const config = resolveGenerationProviderConfig(process.env);
const provider = createGenerationProviderFromEnv(process.env);
const qualityMin = qualityMinimum();
const rounds = Number(process.env.ZYQUOR_EVAL_ROUNDS ?? 1);
const rows = [];

const results = [];
for (let round = 1; round <= rounds; round += 1) {
  for (const item of cases) {
    try {
      const candidates = await provider.generateDraftCandidates({
        idea: item.idea,
        count: 3,
        tweetType: item.tweetType
      });
      results.push({ item, candidates, round });
    } catch (error) {
      results.push({ item, candidates: [], error: String(error?.message ?? error), round });
    }
  }
}

for (const { item, candidates, error, round } of results) {
  if (error) {
    rows.push({ case: item.name, error, round });
    continue;
  }
  for (const candidate of candidates) {
    const heuristic = scoreTweetQuality(candidate.text);
    rows.push({
      case: item.name,
      round,
      modelRank: candidate.score?.rank ?? null,
      text: candidate.text,
      clean: isCleanTweetText(candidate.text),
      heuristic,
      passesFloor: passesTweetQualityFloor(candidate.text, qualityMin)
    });
  }
}

const judged = rows.filter((row) => row.text);
let judgeError = null;
if (judged.length > 0) {
  const listing = judged.map((row, index) => {
    const item = cases.find((candidate) => candidate.name === row.case);
    const roundLabel = rounds > 1 ? ` [round ${row.round}]` : "";
    return `${index + 1}. Case: ${row.case}${roundLabel}\nInput context:\n${item?.idea ?? ""}\nPost:\n${row.text}`;
  }).join("\n\n");
  try {
    const raw = await runCommandCode(
      `${JUDGE_RUBRIC}\n\nPosts:\n${listing}`,
      process.env.ZYQUOR_COMMAND_CODE_MODEL || "gpt-5.6-luna"
    );
    for (const verdict of parseJudge(raw, judged.length)) {
      const row = judged[verdict.n - 1];
      if (row) Object.assign(row, { judge: verdict.score, verdict: verdict.verdict, fault: verdict.fault, fix: verdict.fix });
    }
  } catch (error) {
    judgeError = String(error?.message ?? error).slice(0, 500);
  }
}

const scored = judged.filter((row) => typeof row.judge === "number");
const meanJudgeScore = scored.length ? scored.reduce((total, row) => total + row.judge, 0) / scored.length : null;
const meanHeuristicScore = judged.length
  ? judged.reduce((total, row) => total + row.heuristic, 0) / judged.length
  : null;
const localPasses = judged.filter((row) => row.passesFloor).length;
const judgeCoverage = judged.length ? scored.length / judged.length : 0;
const localPassRate = judged.length ? localPasses / judged.length : 0;
const generationFailures = rows.filter((row) => row.error).length;
const ok = generationFailures === 0 && judgeError === null && judgeCoverage === 1 && localPassRate === 1;
console.log(JSON.stringify({
  ok,
  generation: config,
  qualityMinimum: qualityMin,
  generationFailures,
  judgeError,
  judgeCoverage,
  localPassRate,
  meanJudgeScore,
  meanHeuristicScore,
  rows
}, null, 2));
if (!ok) process.exitCode = 1;
