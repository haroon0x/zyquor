import { nextAutopostScheduledFor } from "../packages/core/dist/index.js";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const gapMinMinutes = Number(process.env.ZYQUOR_POST_GAP_MIN_MINUTES ?? 30);
const gapMaxMinutes = Number(process.env.ZYQUOR_POST_GAP_MAX_MINUTES ?? 90);
const iterations = Number(process.env.ZYQUOR_VERIFY_SPACING_ITERATIONS ?? 20);

const minMs = gapMinMinutes * 60_000;
const maxMs = gapMaxMinutes * 60_000;
const jitterCeiling = maxMs * 1.2;

const gaps = [];
let lastScheduledFor = null;
let anchor = Date.parse(new Date().toISOString());
const recentGapMs = [];

for (let i = 0; i < iterations; i += 1) {
  const result = nextAutopostScheduledFor({
    lastScheduledFor,
    timestamp: new Date(anchor).toISOString(),
    gapMinMinutes,
    gapMaxMinutes,
    recentGapMs
  });
  const prev = lastScheduledFor ? Date.parse(lastScheduledFor) : anchor;
  const actualGap = Date.parse(result.scheduledFor) - prev;
  gaps.push({ ...result, actualGapMs: actualGap });
  recentGapMs.push(actualGap);
  if (recentGapMs.length > 5) recentGapMs.shift();
  lastScheduledFor = result.scheduledFor;
  anchor = Date.parse(result.scheduledFor);
}

const actualGaps = gaps.map((g) => g.actualGapMs);
const actualMinutes = actualGaps.map((g) => g / 60_000);
const allInRange = actualGaps.every((g) => g >= minMs && g <= jitterCeiling);
const mean = actualMinutes.reduce((sum, v) => sum + v, 0) / actualMinutes.length;
const variance = actualMinutes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / actualMinutes.length;
const stddev = Math.sqrt(variance);
const min = Math.min(...actualMinutes);
const max = Math.max(...actualMinutes);

let tooClose = 0;
for (let i = 1; i < actualGaps.length; i += 1) {
  const prev = actualGaps[i - 1];
  const curr = actualGaps[i];
  if (prev > 0 && curr / prev >= 0.7 && curr / prev <= 1.4) {
    tooClose += 1;
  }
}

console.log(
  JSON.stringify(
    {
      config: { gapMinMinutes, gapMaxMinutes, iterations },
      summary: {
        meanMinutes: Number(mean.toFixed(2)),
        stddevMinutes: Number(stddev.toFixed(2)),
        minMinutes: Number(min.toFixed(2)),
        maxMinutes: Number(max.toFixed(2)),
        allInRange,
        consecutiveWithinR40Percent: tooClose
      },
      gaps: actualMinutes.map((m) => Number(m.toFixed(2)))
    },
    null,
    2
  )
);

if (!allInRange) {
  console.error(`FAIL: at least one gap fell outside [${gapMinMinutes}, ${gapMaxMinutes * 1.2}] min`);
  process.exit(1);
}
if (tooClose > 2) {
  console.error(`FAIL: ${tooClose} consecutive gaps within 40% of each other (expected <= 2)`);
  process.exit(1);
}
if (stddev < 10) {
  console.error(`FAIL: stddev ${stddev.toFixed(2)} min too low (expected >= 10 for high variance)`);
  process.exit(1);
}
console.log("OK: spacing looks random and within range");
