// Processes pending demo-check jobs: URL in → run checks → pending reply
// draft in the Zyquor DB (status='pending', human approves before posting).
//
// Queue file: data/demo-checks.jsonl  ({"url","replyToUrl","handle"} per line)
// Usage:
//   node services/demo-checker/run-queue.mjs           # process all
//   DRY_RUN=1 node services/demo-checker/run-queue.mjs # print replies only

import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runDemoChecks } from "./checker.mjs";
import { formatDemoReply } from "./format.mjs";

const require = createRequire(new URL("../../packages/browser/package.json", import.meta.url));
const { DatabaseSync } = require("node:sqlite");
const crypto = await import("node:crypto");

const queuePath = process.env.ZYQUOR_DEMO_QUEUE ?? new URL("../../data/demo-checks.jsonl", import.meta.url).pathname;
const dbPath = process.env.ZYQUOR_MENTIONS_DB ?? "/mnt/c/Users/asus/AppData/Roaming/Zyquor/data/app.sqlite";
const dryRun = process.env.DRY_RUN === "1";

if (!existsSync(queuePath)) {
  console.log("Queue is empty.");
  process.exit(0);
}

const jobs = readFileSync(queuePath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  })
  .filter(Boolean);

if (jobs.length === 0) {
  console.log("Queue is empty.");
  process.exit(0);
}

console.log(`Processing ${jobs.length} demo-check job(s)${dryRun ? " [DRY RUN]" : ""}...`);
let db = null;
if (!dryRun) {
  if (!existsSync(dbPath)) {
    console.error(`DB not found: ${dbPath}`);
    process.exit(1);
  }
  db = new DatabaseSync(dbPath);
}

const remaining = [];
for (const job of jobs) {
  try {
    const findings = await runDemoChecks(job.url);
    const reply = formatDemoReply(findings);
    console.log(`\n${job.url}\n-> ${reply}`);
    if (!dryRun) {
      const now = new Date().toISOString();
      db.prepare(
        "INSERT INTO drafts (id,account_id,source_type,source_input,generated_text,edited_text,reply_to_url,metadata_json,status,created_at,updated_at,reply_to_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
      ).run(
        `draft_${crypto.randomUUID()}`,
        job.accountId,
        "mention",
        JSON.stringify({ origin: "demo-checker", url: job.url }),
        reply,
        null,
        job.replyToUrl,
        JSON.stringify({ yolo: false, autopost: false, count: 1, tweetType: "reply", origin: "demo-checker" }),
        "pending",
        now,
        now,
        null
      );
      console.log("   pending reply draft created.");
    }
  } catch (error) {
    console.error(`FAILED ${job.url}: ${error.message}`);
    remaining.push(job); // keep for retry on next run
  }
}

if (!dryRun) writeFileSync(queuePath, remaining.join("\n"));
