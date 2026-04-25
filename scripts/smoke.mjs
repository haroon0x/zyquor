import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const now = () => new Date().toISOString();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createDraftCandidates(idea) {
  const base = idea.trim().replace(/\s+/g, " ");
  return [
    `${base}\n\nThe hidden cost is not the tooling. It is losing the audit trail between idea, draft, approval, and action.`,
    `${base}\n\nGood local tools should make every step inspectable: what changed, who approved it, and what happened in the browser.`,
    `${base}\n\nThe best automation still keeps the final human decision visible. Draft faster, review clearly, act deliberately.`
  ];
}

const db = new DatabaseSync(":memory:");
db.exec(readFileSync("packages/storage/migrations/0001_initial.sql", "utf8"));

const timestamp = now();
db.prepare(
  `INSERT INTO style_profiles (
    id, name, description, tone, rules_json, banned_phrases_json, example_posts_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run("style_default", "Default", "Default concise posting style.", "clear", "{}", "[]", "[]", timestamp, timestamp);

db.prepare(
  `INSERT INTO accounts (
    id, handle, display_name, profile_dir, style_profile_id, posting_mode, enabled,
    daily_post_limit, quiet_hours_start, quiet_hours_end, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(
  "account_personal",
  "personal-main",
  "Personal main",
  "profiles/personal-main",
  "style_default",
  "prepare_only",
  1,
  5,
  null,
  null,
  timestamp,
  timestamp
);

const idea = "Make local automation auditable.";
const candidates = createDraftCandidates(idea);
const draftId = `draft_${randomUUID()}`;
const draftCreatedAt = now();

db.exec("BEGIN IMMEDIATE");
db.prepare(
  `INSERT INTO drafts (
    id, account_id, source_type, source_input, generated_text, edited_text, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(
  draftId,
  "account_personal",
  "text",
  idea,
  candidates[0],
  candidates[0],
  "selected",
  draftCreatedAt,
  draftCreatedAt
);

for (const [index, text] of candidates.entries()) {
  db.prepare(
    `INSERT INTO draft_candidates (id, draft_id, text, score_json, selected, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`candidate_${randomUUID()}`, draftId, text, JSON.stringify({ provider: "mock", rank: index + 1 }), index === 0 ? 1 : 0, draftCreatedAt);
}
db.exec("COMMIT");

const draft = db.prepare("SELECT * FROM drafts WHERE id = ?").get(draftId);
assert(draft.status === "selected", "draft should start selected");

const jobId = `job_${randomUUID()}`;
const approvedAt = now();
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE drafts SET edited_text = ?, status = ?, updated_at = ? WHERE id = ?").run(
  `${candidates[0]}\n\nEdited in review.`,
  "approved",
  approvedAt,
  draftId
);
db.prepare(
  `INSERT INTO post_jobs (
    id, account_id, draft_id, status, mode, scheduled_for, approved_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(jobId, "account_personal", draftId, "approved", "prepare_only", null, approvedAt, approvedAt, approvedAt);
db.exec("COMMIT");

const approvedJob = db.prepare("SELECT * FROM post_jobs WHERE id = ?").get(jobId);
assert(approvedJob.status === "approved", "job should be approved");

const attemptId = `attempt_${randomUUID()}`;
const preparedAt = now();
db.exec("BEGIN IMMEDIATE");
db.prepare("UPDATE post_jobs SET status = ?, updated_at = ? WHERE id = ?").run("running", preparedAt, jobId);
db.prepare(
  `INSERT INTO post_attempts (
    id, job_id, status, error_code, error_message, screenshot_path, trace_path, started_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(attemptId, jobId, "started", null, null, null, null, preparedAt, null);
db.prepare("UPDATE post_jobs SET status = ?, updated_at = ? WHERE id = ?").run("prepared", preparedAt, jobId);
db.prepare(
  `INSERT INTO post_attempts (
    id, job_id, status, error_code, error_message, screenshot_path, trace_path, started_at, finished_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(`attempt_${randomUUID()}`, jobId, "text_inserted", null, null, null, null, preparedAt, null);
db.exec("COMMIT");

const preparedJob = db.prepare("SELECT * FROM post_jobs WHERE id = ?").get(jobId);
const attemptCount = db.prepare("SELECT COUNT(*) AS count FROM post_attempts WHERE job_id = ?").get(jobId).count;
const selectedCount = db.prepare("SELECT COUNT(*) AS count FROM draft_candidates WHERE draft_id = ? AND selected = 1").get(draftId).count;

assert(preparedJob.status === "prepared", "job should be prepared");
assert(attemptCount === 2, "prepare should record two attempts");
assert(selectedCount === 1, "exactly one candidate should be selected");

console.log(
  JSON.stringify(
    {
      ok: true,
      draftId,
      jobId,
      finalJobStatus: preparedJob.status,
      candidates: candidates.length,
      attempts: attemptCount
    },
    null,
    2
  )
);
