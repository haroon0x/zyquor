import { buildApp } from "../apps/api/dist/app.js";
import { createMemoryRepository } from "../packages/storage/dist/index.js";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const app = await buildApp({
  enableBrowserPost: false,
  generationProvider: {
    name: "test",
    model: "test",
    async generateDraftCandidates(input) {
      if (input.idea.includes("slop")) {
        return [
          {
            text: "Let's dive in and unlock the power of seamless synergy.",
            score: { quality: -1, provider: "test" }
          }
        ];
      }
      if (input.idea.includes("vague")) {
        return [
          {
            text: "Interesting how databases keep evolving!",
            score: { quality: 0, provider: "test" }
          }
        ];
      }
      return [
        {
          text: "SQLite handles 35% of write loads fine if you batch over 60 rows.",
          score: { quality: 5, provider: "test" }
        }
      ];
    }
  },
  repository: createMemoryRepository()
});

try {
  const account = (await app.inject({ method: "GET", url: "/accounts" })).json();
  const accountId = account.accounts?.[0]?.id;
  if (!accountId) {
    console.error("No account available");
    process.exit(1);
  }

  console.log("Test 1: high quality candidate should auto-approve");
  const good = await app.inject({
    method: "POST",
    url: "/drafts",
    payload: { accountId, idea: "specific tweet idea", count: 1, yolo: true, autopost: true }
  });
  const goodGen = await app.inject({ method: "POST", url: `/drafts/${good.json().draft.id}/generate` });
  console.log("  status:", goodGen.statusCode);
  console.log("  job scheduledFor:", goodGen.json().job?.scheduledFor);
  const goodGap = goodGen.json().job?.scheduledFor
    ? (Date.parse(goodGen.json().job.scheduledFor) - Date.now()) / 60_000
    : null;
  console.log("  gap (min from now):", goodGap?.toFixed(2));

  console.log("\nTest 2: vague candidate should be rejected with all_below_quality_floor");
  const vague = await app.inject({
    method: "POST",
    url: "/drafts",
    payload: { accountId, idea: "vague tweet idea", count: 1, yolo: true, autopost: true }
  });
  const vagueGen = await app.inject({ method: "POST", url: `/drafts/${vague.json().draft.id}/generate` });
  console.log("  status:", vagueGen.statusCode);
  console.log("  body:", JSON.stringify(vagueGen.json(), null, 2));

  console.log("\nTest 3: slop candidate should be rejected with ai_slop_phrase_detected");
  const slop = await app.inject({
    method: "POST",
    url: "/drafts",
    payload: { accountId, idea: "slop tweet idea", count: 1, yolo: true, autopost: true }
  });
  const slopGen = await app.inject({ method: "POST", url: `/drafts/${slop.json().draft.id}/generate` });
  console.log("  status:", slopGen.statusCode);
  console.log("  body:", JSON.stringify(slopGen.json(), null, 2));
} finally {
  await app.close();
}
