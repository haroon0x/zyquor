import {
  aggregateSources,
  createArxivAdapter,
  createCompanyRssAdapter,
  createGitHubTrendingAdapter,
  createHackerNewsAdapter,
  createHiringAdapter,
  createProductHuntAdapter,
  createRedditAdapter,
  createTechCrunchAdapter
} from "../packages/adapters/dist/index.js";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const timeoutMs = Number(process.env.ZYQUOR_ADAPTER_SMOKE_TIMEOUT_MS ?? 20_000);

function withTimeout(label, promise) {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]);
}

function compactItem(item) {
  return {
    title: item.title,
    url: item.url,
    source: item.source ?? item.metadata?.source ?? null
  };
}

async function runCheck(check) {
  const started = Date.now();
  try {
    const items = await withTimeout(check.label, check.fetch());
    const count = Array.isArray(items) ? items.length : 0;
    const ok = check.optional ? true : count >= (check.minItems ?? 1);
    return {
      count,
      durationMs: Date.now() - started,
      error: null,
      label: check.label,
      ok,
      optional: check.optional,
      sample: items.slice(0, 2).map(compactItem)
    };
  } catch (error) {
    return {
      count: 0,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
      label: check.label,
      ok: Boolean(check.optional),
      optional: check.optional,
      sample: []
    };
  }
}

const checks = [
  {
    label: "hackernews-top",
    fetch: () => createHackerNewsAdapter({ maxItems: 3 }).fetch()
  },
  {
    label: "hackernews-best",
    fetch: () => createHackerNewsAdapter({ feed: "beststories", maxItems: 3 }).fetch()
  },
  {
    label: "hackernews-jobs",
    fetch: () => createHiringAdapter({ maxItems: 3 }).fetch()
  },
  {
    label: "reddit-programming",
    fetch: () => createRedditAdapter({ maxItems: 3, minScore: 1, subreddit: "programming" }).fetch()
  },
  {
    label: "reddit-machinelearning",
    fetch: () => createRedditAdapter({ maxItems: 3, minScore: 1, subreddit: "MachineLearning" }).fetch()
  },
  {
    label: "arxiv-cs-ai",
    fetch: () => createArxivAdapter({ categories: ["cs.AI"], maxItems: 3 }).fetch()
  },
  {
    label: "techcrunch-ai",
    fetch: () => createTechCrunchAdapter({ maxItems: 3, sections: ["ai"] }).fetch()
  },
  {
    label: "github-ai",
    fetch: () => createGitHubTrendingAdapter({ maxItems: 3, minStars: 100, topic: "ai" }).fetch()
  },
  {
    label: "company-rss",
    fetch: () => createCompanyRssAdapter({ maxItems: 3 }).fetch()
  },
  {
    label: "aggregated-news",
    fetch: () =>
      aggregateSources({
        includeProductHunt: Boolean(process.env.ZYQUOR_PRODUCTHUNT_API_TOKEN),
        maxItems: 5
      })
  },
  {
    label: "producthunt",
    fetch: () => createProductHuntAdapter({ maxItems: 3 }).fetch(),
    optional: !process.env.ZYQUOR_PRODUCTHUNT_API_TOKEN
  }
];

console.log("Live adapter smoke");
console.log(`Timeout: ${timeoutMs}ms`);

const results = [];
for (const check of checks) {
  const result = await runCheck(check);
  results.push(result);
  const status = result.ok ? "ok" : "fail";
  const optional = result.optional ? " optional" : "";
  console.log(`${status}${optional} ${result.label}: ${result.count} item(s), ${result.durationMs}ms`);
  if (result.error) {
    console.log(`  error: ${result.error}`);
  }
  for (const item of result.sample) {
    console.log(`  - ${item.title} <${item.url}>`);
  }
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(`\nFailed live adapter checks: ${failed.map((result) => result.label).join(", ")}`);
  process.exit(1);
}

console.log("\nAll required live adapter checks returned data.");
