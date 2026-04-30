import {
  createGenerationProviderFromEnv,
  isCleanTweetText,
  resolveGenerationProviderConfig
} from "../packages/generation/dist/index.js";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const cases = [
  {
    name: "news-context",
    idea:
      "News headline: Noctua released official 3D CAD models for its cooling fans. Original URL: https://www.noctua.at/en/3d-cad-models. Known summary: PC builders can use official files to verify fit and clearances before buying hardware. Verified facts: official models are available; fitment checks are the user value.",
    tweetType: "useful_info"
  },
  {
    name: "maintainability",
    idea:
      "News headline: The Zig project explained its anti-AI contribution policy. Known summary: maintainers reject generated patches because authors must understand, explain, and maintain their code over time. Verified facts: maintainability and accountability are central.",
    tweetType: "news_context"
  },
  {
    name: "release",
    idea:
      "News headline: Zed 1.0 is available. Known summary: the editor reached a stable release after years of work on collaboration, speed, and native performance. Verified facts: release milestone; developer workflow impact.",
    tweetType: "feed_observation"
  }
];

const config = resolveGenerationProviderConfig(process.env);
const provider = createGenerationProviderFromEnv(process.env);
const failures = [];
const outputs = [];

for (const item of cases) {
  const candidates = await provider.generateDraftCandidates({
    idea: item.idea,
    count: 3,
    tweetType: item.tweetType
  });
  for (const candidate of candidates) {
    const clean = isCleanTweetText(candidate.text);
    outputs.push({ case: item.name, clean, text: candidate.text, score: candidate.score });
    if (!clean) failures.push({ case: item.name, text: candidate.text });
  }
}

console.log(JSON.stringify({ ok: failures.length === 0, generation: config, outputs, failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
