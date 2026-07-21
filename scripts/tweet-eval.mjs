import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import {
  createGenerationProviderFromEnv,
  isCleanTweetText,
  resolveGenerationProviderConfig,
  scoreTweetQuality
} from "../packages/generation/dist/index.js";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const cases = [
  {
    name: "arxiv-replay",
    tweetType: "article_summary",
    idea: "Source title: Deterministic Replay for AI Agent Systems\nRequired source link: <source-url>https://arxiv.org/abs/2607.16200</source-url>\nKnown summary: agent systems that couple LLMs with external tools are non-deterministic because of LLM sampling variance, external API state, CDN infrastructure headers, and execution-environment noise.\nVerified facts:\n- existing observability platforms capture execution logs but cannot reproduce a run in isolation\n- agrepl is a developer-first CLI framework for deterministic replay"
  },
  {
    name: "show-hn-index",
    tweetType: "article_summary",
    idea: "Source title: Show HN: Ex Situ, open-source spatial index of displaced cultural artifacts\nRequired source link: <source-url>https://exsitu.app/map</source-url>\nKnown summary: a spatial index that maps museum artefacts as arcs from origin site to holding institution.\nVerified facts:\n- AGPL-3.0, Next.js + Deck.gl frontend, Strapi backend, Python ETL over museum open-access APIs\n- indexes over 100k artifacts across 8 collections including the Met, V&A, SMB Berlin\n- started as an MA thesis in 2022, built mostly solo"
  },
  {
    name: "release-note",
    tweetType: "news_context",
    idea: "Source title: Zed 1.0 released\nKnown summary: the editor reached a stable release after years of work on collaboration, speed, and native performance.\nVerified facts:\n- 1.0 is the first stable release\n- focus areas were collaboration, speed, native performance"
  },
  {
    name: "ops-lesson",
    tweetType: "lesson",
    idea: "We moved a low-traffic internal service off Kubernetes onto a single Docker host. Verified facts: the service does not need autoscaling, multi-region routing, or fast node replacement; the migration removed cluster upgrades, RBAC config, and scheduler debugging from the on-call load."
  },
  {
    name: "tool-note",
    tweetType: "tool",
    idea: "ripgrep is used for repository-wide text search. Verified facts: it searches large repositories quickly; it matches text, not symbols, so it cannot distinguish a definition from a mention."
  }
];

const JUDGE_RUBRIC = `You are grading public X posts against a high editorial bar. For each numbered post return JSON only:
{"posts":[{"n":1,"score":7,"verdict":"strong|ok|weak","fault":"one short phrase","fix":"one short instruction"}]}
Score 1-10 on: does it carry one thought worth keeping (not a source recap), is the anchor concrete, is the payoff supported, does it read like a person rather than a model, is the opener earned. 8+ means you would post it from your own account. Be strict: a fluent recap is a 4.`;

function runCommandCode(prompt, model) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.ZYQUOR_COMMAND_CODE_PATH || "command-code", [
      "--skip-onboarding",
      "--permission-mode",
      "plan",
      "--model",
      model,
      "--print"
    ], { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
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

function parseJudge(raw) {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  try {
    return JSON.parse(raw.slice(start, end + 1)).posts ?? [];
  } catch {
    return [];
  }
}

const config = resolveGenerationProviderConfig(process.env);
const provider = createGenerationProviderFromEnv(process.env);
const rows = [];

const results = [];
for (const item of cases) {
  try {
    const candidates = await provider.generateDraftCandidates({
      idea: item.idea,
      count: 3,
      tweetType: item.tweetType
    });
    results.push({ item, candidates });
  } catch (error) {
    results.push({ item, candidates: [], error: String(error.message ?? error) });
  }
}

for (const { item, candidates, error } of results) {
  if (error) {
    rows.push({ case: item.name, error });
    continue;
  }
  for (const candidate of candidates) {
    rows.push({
      case: item.name,
      text: candidate.text,
      clean: isCleanTweetText(candidate.text),
      heuristic: scoreTweetQuality(candidate.text)
    });
  }
}

const judged = rows.filter((row) => row.text);
if (judged.length > 0) {
  const listing = judged.map((row, index) => `${index + 1}. ${row.text}`).join("\n\n");
  const raw = await runCommandCode(
    `${JUDGE_RUBRIC}\n\nPosts:\n${listing}`,
    process.env.ZYQUOR_COMMAND_CODE_MODEL || "deepseek/deepseek-v4-pro"
  );
  for (const verdict of parseJudge(raw)) {
    const row = judged[Number(verdict.n) - 1];
    if (row) Object.assign(row, { judge: verdict.score, verdict: verdict.verdict, fault: verdict.fault, fix: verdict.fix });
  }
}

const scored = judged.filter((row) => typeof row.judge === "number");
const mean = scored.length ? scored.reduce((total, row) => total + row.judge, 0) / scored.length : null;
console.log(JSON.stringify({ generation: config, meanJudgeScore: mean, rows }, null, 2));
