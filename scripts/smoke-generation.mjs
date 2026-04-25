import { createGenerationProviderFromEnv, resolveGenerationProviderConfig } from "../packages/generation/dist/index.js";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();
const config = resolveGenerationProviderConfig(process.env);

try {
  const provider = createGenerationProviderFromEnv(process.env);
  const candidates = await provider.generateDraftCandidates({
    idea: process.env.ZYQUOR_SMOKE_IDEA ?? "Make local automation auditable.",
    count: Number(process.env.ZYQUOR_SMOKE_COUNT ?? 2)
  });

  if (candidates.length < 1) {
    throw new Error("generation smoke expected at least one candidate");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        generation: config,
        candidates: candidates.map((candidate) => ({
          text: candidate.text,
          score: candidate.score
        }))
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        generation: config,
        error: error instanceof Error ? error.message : "Unknown generation error"
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
