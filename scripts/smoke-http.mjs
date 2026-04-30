import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function candidatesFor(idea) {
  const base = idea.trim().replace(/\s+/g, " ");
  return [
    `${base}\n\nThe hidden cost is not the tooling. It is losing the audit trail between idea, draft, approval, and action.`,
    `${base}\n\nGood local tools should make every step inspectable: what changed, who approved it, and what happened in the browser.`,
    `${base}\n\nThe best automation still keeps the final human decision visible. Draft faster, review clearly, act deliberately.`
  ];
}

const db = new DatabaseSync(":memory:");
db.exec(readFileSync("packages/storage/migrations/0001_initial.sql", "utf8"));

const now = () => new Date().toISOString();
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
).run("account_personal", "personal-main", "Personal main", "profiles/personal-main", "style_default", "prepare_only", 1, 5, null, null, timestamp, timestamp);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/accounts") {
      return json(res, 200, { accounts: db.prepare("SELECT * FROM accounts").all() });
    }

    if (req.method === "POST" && url.pathname === "/drafts") {
      const body = await readJson(req);
      const texts = candidatesFor(body.idea);
      const draftId = `draft_${randomUUID()}`;
      const createdAt = now();
      db.prepare(
        `INSERT INTO drafts (
          id, account_id, source_type, source_input, generated_text, edited_text, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(draftId, body.accountId, "text", body.idea, texts[0], texts[0], "selected", createdAt, createdAt);

      const candidates = texts.map((text, index) => {
        const candidate = {
          id: `candidate_${randomUUID()}`,
          draft_id: draftId,
          text,
          selected: index === 0
        };
        db.prepare(
          `INSERT INTO draft_candidates (id, draft_id, text, score_json, selected, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(candidate.id, candidate.draft_id, candidate.text, JSON.stringify({ provider: "seed", rank: index + 1 }), candidate.selected ? 1 : 0, createdAt);
        return candidate;
      });

      return json(res, 201, { draft: { id: draftId, editedText: texts[0], status: "selected" }, candidates });
    }

    const approveMatch = url.pathname.match(/^\/drafts\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const body = await readJson(req);
      const draftId = approveMatch[1];
      const jobId = `job_${randomUUID()}`;
      const approvedAt = now();
      db.prepare("UPDATE drafts SET edited_text = ?, status = ?, updated_at = ? WHERE id = ?").run(body.editedText, "approved", approvedAt, draftId);
      db.prepare(
        `INSERT INTO post_jobs (
          id, account_id, draft_id, status, mode, scheduled_for, approved_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(jobId, "account_personal", draftId, "approved", "prepare_only", null, approvedAt, approvedAt, approvedAt);
      return json(res, 201, { job: { id: jobId, status: "approved" } });
    }

    const prepareMatch = url.pathname.match(/^\/jobs\/([^/]+)\/prepare$/);
    if (req.method === "POST" && prepareMatch) {
      const jobId = prepareMatch[1];
      const preparedAt = now();
      db.prepare("UPDATE post_jobs SET status = ?, updated_at = ? WHERE id = ?").run("prepared", preparedAt, jobId);
      db.prepare(
        `INSERT INTO post_attempts (
          id, job_id, status, error_code, error_message, screenshot_path, trace_path, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(`attempt_${randomUUID()}`, jobId, "text_inserted", null, null, null, null, preparedAt, null);
      return json(res, 200, { job: { id: jobId, status: "prepared" }, dryRun: true });
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : "Unknown error" });
  }
});

async function runOverHttp() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const health = await fetch(`${baseUrl}/health`).then((res) => res.json());
  assert(health.ok === true, "health should be ok");

  const draft = await fetch(`${baseUrl}/drafts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: "account_personal", idea: "Make local automation auditable." })
  }).then((res) => res.json());
  assert(draft.draft.status === "selected", "draft should be selected");
  assert(draft.candidates.length === 3, "should create 3 candidates");

  const approved = await fetch(`${baseUrl}/drafts/${draft.draft.id}/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ editedText: `${draft.draft.editedText}\n\nEdited.` })
  }).then((res) => res.json());
  assert(approved.job.status === "approved", "job should be approved");

  const prepared = await fetch(`${baseUrl}/jobs/${approved.job.id}/prepare`, { method: "POST" }).then((res) => res.json());
  assert(prepared.job.status === "prepared", "job should be prepared");

  await new Promise((resolve) => server.close(resolve));
  return {
    mode: "http",
    baseUrl,
    draftId: draft.draft.id,
    jobId: approved.job.id,
    finalJobStatus: prepared.job.status
  };
}

function runInProcessFallback(error) {
  const texts = candidatesFor("Make local automation auditable.");
  const draftId = `draft_${randomUUID()}`;
  const jobId = `job_${randomUUID()}`;
  const createdAt = now();

  db.prepare(
    `INSERT INTO drafts (
      id, account_id, source_type, source_input, generated_text, edited_text, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(draftId, "account_personal", "text", "Make local automation auditable.", texts[0], texts[0], "selected", createdAt, createdAt);
  db.prepare(
    `INSERT INTO post_jobs (
      id, account_id, draft_id, status, mode, scheduled_for, approved_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, "account_personal", draftId, "approved", "prepare_only", null, createdAt, createdAt, createdAt);
  db.prepare("UPDATE post_jobs SET status = ?, updated_at = ? WHERE id = ?").run("prepared", now(), jobId);

  const prepared = db.prepare("SELECT * FROM post_jobs WHERE id = ?").get(jobId);
  assert(prepared.status === "prepared", "fallback job should be prepared");

  return {
    mode: "in-process-fallback",
    networkBlocked: error.code ?? "unknown",
    draftId,
    jobId,
    finalJobStatus: prepared.status
  };
}

let result;
try {
  result = await runOverHttp();
} catch (error) {
  result = runInProcessFallback(error);
}

console.log(JSON.stringify({ ok: true, ...result }, null, 2));
