// Proposes standing corrections from measured post performance.
//
// Read-only on the DB. Compares top vs bottom posts by views using the
// content features frozen at approval time, derives concrete observations,
// and appends PROPOSED corrections to the feedback notebook. Nothing is
// auto-applied: a correction only takes effect when the operator adds it
// through the style panel (the existing human-approved loop).
//
// Honesty rules:
// - refuses to propose anything below a minimum sample size
// - states the numbers behind every proposal
// - never proposes content-strategy claims from voice-level data
//
// Usage: node scripts/propose-lessons.mjs [--dry]

import { createRequire } from "node:module";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_("node:sqlite");
const { analyzePostFeatures } = await import("../packages/automation/dist/index.js");

const dbPath = process.env.ZYQUOR_MENTIONS_DB
  ?? (process.env.ZYQUOR_DATA_ROOT
    ? join(process.env.ZYQUOR_DATA_ROOT, "data", "app.sqlite")
    : "data/app.sqlite");
const dataRoot = process.env.ZYQUOR_DATA_ROOT ?? process.cwd();
const notebookDir = process.env.ZYQUOR_FEEDBACK_DIR ?? join(dataRoot, "feedback");
const dry = process.argv.includes("--dry");

const MIN_SAMPLE = Number(process.env.ZYQUOR_PROPOSE_MIN_SAMPLE ?? 6);
const MIN_VIEWS_FOR_SIGNAL = Number(process.env.ZYQUOR_PROPOSE_MIN_VIEWS ?? 30);

if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

function featuresOf(postedText, metadataJson) {
  let meta = {};
  try {
    meta = metadataJson ? JSON.parse(metadataJson) : {};
  } catch {
    meta = {};
  }
  // Prefer features frozen at approval; fall back to deriving from text so
  // historical posts still contribute.
  return meta.features ?? analyzePostFeatures(postedText ?? "");
}

function performanceOf(metadataJson) {
  try {
    const meta = metadataJson ? JSON.parse(metadataJson) : {};
    return meta.performance ?? null;
  } catch {
    return null;
  }
}

const posts = db
  .prepare("SELECT account_id, posted_text, metadata_json FROM post_history ORDER BY posted_at ASC")
  .all()
  .map((row) => {
    const performance = performanceOf(row.metadata_json);
    return {
      accountId: row.account_id,
      text: row.posted_text ?? "",
      features: featuresOf(row.posted_text, row.metadata_json),
      views: performance?.views ?? null,
      likes: performance?.likes ?? 0,
      reposts: performance?.reposts ?? 0,
      replies: performance?.replies ?? 0
    };
  })
  .filter((post) => post.views !== null);

console.log(`Measured posts: ${posts.length} (need >= ${MIN_SAMPLE} to propose anything)`);

if (posts.length < MIN_SAMPLE) {
  console.log(
    `Not enough data to propose lessons yet. Keep posting and measuring; ` +
    `run this again around ${MIN_SAMPLE}+ measured posts.`
  );
  process.exit(0);
}

const totalReach = posts.reduce((sum, p) => sum + (p.views ?? 0), 0);
if (totalReach < MIN_VIEWS_FOR_SIGNAL) {
  console.log(
    `Total reach across all measured posts is ${totalReach} views — below the ` +
    `${MIN_VIEWS_FOR_SIGNAL}-view floor where differences mean anything. No proposals.`
  );
  process.exit(0);
}

// Compare top half vs bottom half by views within each account (accounts have
// different audiences; cross-account comparison would be noise).
const proposals = [];
for (const accountId of [...new Set(posts.map((p) => p.accountId))]) {
  const mine = posts.filter((p) => p.accountId === accountId).sort((a, b) => b.views - a.views);
  if (mine.length < MIN_SAMPLE) continue;
  const mid = Math.floor(mine.length / 2);
  const top = mine.slice(0, mid);
  const bottom = mine.slice(mid);

  const avg = (arr, key) => arr.reduce((s, p) => s + p.features[key], 0) / arr.length;

  const checks = [
    ["hasDigits", "posts with a concrete number"],
    ["endsWithQuestion", "posts ending in a question"],
    ["linkCount", "link count"]
  ];
  for (const [key, label] of checks) {
    const topAvg = avg(top, key);
    const bottomAvg = avg(bottom, key);
    if (topAvg > bottomAvg * 1.5 && topAvg - bottomAvg >= 0.34) {
      proposals.push({
        accountId,
        evidence: `${Math.round(topAvg * 100)}% of top-half posts vs ${Math.round(bottomAvg * 100)}% of bottom-half ${label} (top avg ${(top.reduce((s, p) => s + p.views) / top.length).toFixed(0)} views, bottom ${(bottom.reduce((s, p) => s + p.views) / bottom.length).toFixed(0)})`,
        correction: label.includes("number")
          ? "Include one concrete number in every post."
          : label.includes("question")
            ? "End more posts with a question to invite replies."
            : "Include the source link in the post body."
      });
    }
  }

  // Opener overlap: does any bottom-half opener phrase repeat in the top?
  const bottomOpeners = new Set(bottom.map((p) => p.features.opener));
  const repeatedWeakOpener = top.filter((p) => bottomOpeners.has(p.features.opener));
  if (repeatedWeakOpener.length === 0 && top[0].features.opener) {
    proposals.push({
      accountId,
      evidence: `best post (${top[0].views} views) opens "${top[0].features.opener}"`,
      correction: `Open with the payoff in the first three words, like: "${top[0].text.slice(0, 60)}..."`
    });
  }
}

if (proposals.length === 0) {
  console.log("No feature separates top from bottom half strongly enough yet. No proposals.");
  process.exit(0);
}

const stamp = new Date().toISOString();
const lines = [];
for (const p of proposals.slice(0, 3)) {
  lines.push(`## [proposed] ${stamp} — account ${p.accountId}`);
  lines.push("", `Evidence: ${p.evidence}`, "", `> PROPOSED correction: ${p.correction}`, "");
}
const body = lines.join("\n") + "\n";

console.log("\n" + body);
if (dry) {
  console.log("[dry] not written.");
  process.exit(0);
}
mkdirSync(notebookDir, { recursive: true });
appendFileSync(join(notebookDir, "notebook.md"), body, "utf8");
console.log(`Appended ${proposals.length} proposed correction(s) to ${join(notebookDir, "notebook.md")}`);
console.log("Review them and add the ones you agree with via the style panel.");
