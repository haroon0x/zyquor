import {
  createGenerationProviderFromEnv,
  isCleanTweetText,
  passesTweetQualityFloor,
  qualityMinimum,
  resolveGenerationProviderConfig
} from "../packages/generation/dist/index.js";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const cases = [
  {
    name: "news-context",
    idea:
      "Title: Noctua released official 3D CAD models for its cooling fans. URL: https://www.noctua.at/en/3d-cad-models. Summary: PC builders can use official files to verify fit and clearances before buying hardware. Facts: official models are available; fitment checks are the user value.",
    tweetType: "useful_info"
  },
  {
    name: "maintainability",
    idea:
      "Title: The Zig project explained its anti-AI contribution policy. Summary: maintainers reject generated patches because authors must understand, explain, and maintain their code over time. Facts: maintainability and accountability are central.",
    tweetType: "news_context"
  },
  {
    name: "release",
    idea:
      "Title: Zed 1.0 is available. Summary: the editor reached a stable release after years of work on collaboration, speed, and native performance. Facts: release milestone; developer workflow impact.",
    tweetType: "feed_observation"
  },
  {
    name: "science-research",
    idea:
      "Title: Battery researchers published a paper on cheaper sodium-ion storage. Summary: lower-cost storage could matter for grid-scale energy projects if durability holds up. Facts: sodium-ion chemistry; grid storage angle; durability remains the key caveat.",
    tweetType: "news_context"
  },
  {
    name: "economy-markets",
    idea:
      "Title: Central bank officials signaled rates may stay higher for longer. Summary: markets are repricing growth stocks and debt-heavy startups. Facts: rate expectations changed; financing costs matter for operators and investors.",
    tweetType: "news_context"
  }
];

const config = resolveGenerationProviderConfig(process.env);
const provider = createGenerationProviderFromEnv(process.env);
const qualityMin = qualityMinimum();
const failures = [];
const generationFailures = [];
const outputs = [];

for (const item of cases) {
  try {
    const candidates = await provider.generateDraftCandidates({
      idea: item.idea,
      count: 3,
      tweetType: item.tweetType
    });
    for (const candidate of candidates) {
      const clean = isCleanTweetText(candidate.text);
      const passesFloor = passesTweetQualityFloor(candidate.text, qualityMin);
      outputs.push({ case: item.name, clean, passesFloor, text: candidate.text, score: candidate.score });
      if (!passesFloor) failures.push({ case: item.name, text: candidate.text });
    }
  } catch (error) {
    const message = String(error?.message ?? error).slice(0, 500);
    generationFailures.push({ case: item.name, error: message });
  }
}

const evaluated = outputs.length;
const localPassRate = evaluated ? (evaluated - failures.length) / evaluated : 0;
const ok = generationFailures.length === 0 && failures.length === 0;
console.log(JSON.stringify({ ok, generation: config, qualityMinimum: qualityMin, localPassRate, outputs, failures, generationFailures }, null, 2));
if (!ok) process.exitCode = 1;
