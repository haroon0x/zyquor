#!/usr/bin/env node
import { existsSync, appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./load-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv(resolve(repoRoot, ".env"));

const generation = await import(new URL("../packages/generation/dist/index.js", import.meta.url));
const core = await import(new URL("../packages/core/dist/index.js", import.meta.url));

const apiUrl = process.env.ZYQUOR_API_URL ?? "http://127.0.0.1:3001";
const intervalArg = process.argv.includes("--interval-ms") ? Number(process.argv[process.argv.indexOf("--interval-ms") + 1]) : NaN;
const intervalMs = (Number.isFinite(intervalArg) && intervalArg > 0) ? intervalArg : 300_000;
const dryRun = process.argv.includes("--dry");
const once = process.argv.includes("--once");
const maxJobDeletesPerCycle = 3;
const maxPostDeletesPerCycle = 2;
const logPath = resolve(repoRoot, "apps/api/data/overseer.jsonl");

function logRecord(record) {
  try {
    appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {}
}

function database() {
  const preferred = resolve(repoRoot, "apps/api/data/app.sqlite");
  if (existsSync(preferred)) return new DatabaseSync(preferred);
  const dataRoot = process.env.ZYQUOR_DATA_ROOT ?? process.cwd();
  return new DatabaseSync(resolve(dataRoot, "data/app.sqlite"));
}

const DASH_PATTERN = /[\u2014\u2013]/;
const INVENTED_NUMBER_LIST = /\bPoint [2-9]\b/;

function flat(text) {
  return (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function hardSlopReasons(text) {
  const reasons = [];
  const value = (text ?? "").trim();
  if (!value) return ["empty_text"];
  const slopList = Array.isArray(core.AI_SLOP_PHRASES) ? core.AI_SLOP_PHRASES : [];
  const flatValue = flat(value);
  for (const phrase of slopList) {
    if (flatValue.includes(String(phrase).toLowerCase())) {
      reasons.push(`slop_phrase:${phrase}`);
      break;
    }
  }
  if (DASH_PATTERN.test(value)) reasons.push("em_or_en_dash");
  if (INVENTED_NUMBER_LIST.test(value)) reasons.push("invented_point_number");
  if (/^[#@]/.test(value)) reasons.push("hashtag_or_mention_opener");
  if ((value.match(/https?:\/\//g) ?? []).length >= 2) reasons.push("link_list");
  return reasons;
}

function queuedReasons(text, isReply) {
  const reasons = hardSlopReasons(text);
  const value = (text ?? "").trim();
  const floor = isReply ? generation.replyQualityMinimum() : generation.qualityMinimum();
  if (generation.scoreTweetQuality(value) < floor) {
    reasons.push(`quality_below_floor (${generation.scoreTweetQuality(value)} < ${floor})`);
  }
  if (!generation.isCleanTweetText(value)) {
    reasons.push("unclean_text");
  }
  if (isReply && generation.isInterrogationDodgeReply(value)) {
    reasons.push(generation.REPLY_DODGE_REASON);
  }
  return reasons;
}

function postedReasons(text, isReply) {
  const hard = hardSlopReasons(text);
  if (hard.length > 0) return hard;
  if (isReply) {
    const floor = generation.replyQualityMinimum();
    if (generation.scoreTweetQuality((text ?? "").trim()) < floor) {
      return [`reply_quality_below_floor (${generation.scoreTweetQuality((text ?? "").trim())} < ${floor})`];
    }
  }
  return [];
}

async function api(path, init) {
  const response = await fetch(`${apiUrl}${path}`, init);
  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { raw: raw.slice(0, 200) }; }
  if (!response.ok) {
    const error = new Error(`${path} ${response.status} ${(body && body.error) || "unknown"}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function candidates(db, draftId) {
  return db.prepare("select text, score_json, selected from draft_candidates where draft_id = ?").all(draftId)
    .map((row) => ({ text: row.text, quality: JSON.parse(row.score_json || "{}").quality, selected: row.selected === 1 }));
}

function bestCandidate(db, draftId) {
  const all = candidates(db, draftId);
  if (all.length === 0) return null;
  const selected = all.find((row) => row.selected);
  if (selected) return selected;
  return [...all].sort((left, right) => Number(right.quality) - Number(left.quality))[0];
}

function draftRow(db, draftId) {
  const row = db.prepare("select metadata_json, reply_to_json, source_input, status from drafts where id = ?").get(draftId);
  if (!row) return null;
  let metadata = {};
  let replyTo = null;
  try { metadata = JSON.parse(row.metadata_json || "{}"); } catch {}
  try { replyTo = row.reply_to_json ? JSON.parse(row.reply_to_json) : null; } catch {}
  return { metadata, replyTo, idea: row.source_input, status: row.status };
}

function hasPostedHistory(db, draftId) {
  return Boolean(db.prepare("select 1 from post_history where draft_id = ? limit 1").get(draftId));
}

async function deleteJobAndDraft(db, job, reasons, isReply, text) {
  const record = { at: new Date().toISOString(), action: "delete_job", jobId: job.id, draftId: job.draftId, mode: job.mode, isReply, reasons, text: text.slice(0, 140) };
  if (dryRun) {
    logRecord({ ...record, dryRun: true });
    return;
  }
  await api(`/jobs/${job.id}`, { method: "DELETE" });
  logRecord(record);
  const draft = draftRow(db, job.draftId);
  if (draft && draft.status === "approved" && !hasPostedHistory(db, job.draftId)) {
    await api(`/drafts/${job.draftId}`, { method: "DELETE" });
    logRecord({ at: new Date().toISOString(), action: "delete_draft", draftId: job.draftId, reason: "sloppy_approved_draft_after_job_delete", reasons });
  }
}

async function auditQueue(db) {
  const jobs = (await api("/jobs?statuses=approved,prepared&limit=500")).jobs;
  let deleted = 0;
  for (const job of jobs) {
    if (deleted >= maxJobDeletesPerCycle) break;
    const draft = draftRow(db, job.draftId);
    if (!draft || hasPostedHistory(db, job.draftId)) continue;
    const isReply = Boolean(draft.replyTo || draft.metadata.tweetType === "reply");
    const best = bestCandidate(db, job.draftId);
    if (!best) continue;
    const reasons = queuedReasons(best.text, isReply);
    if (reasons.length === 0) continue;
    try {
      await deleteJobAndDraft(db, job, reasons, isReply, best.text);
      deleted += 1;
    } catch (error) {
      logRecord({ at: new Date().toISOString(), action: "delete_job_failed", jobId: job.id, error: String(error) });
    }
  }
  return deleted;
}

async function auditReviewQueue(db) {
  const rows = db.prepare(
    "select d.id from drafts d where d.status = 'selected' and not exists(select 1 from post_jobs j where j.draft_id = d.id) and not exists(select 1 from post_history h where h.draft_id = d.id)"
  ).all();
  let deleted = 0;
  for (const row of rows) {
    if (deleted >= maxJobDeletesPerCycle) break;
    const draftId = row.id;
    const draft = draftRow(db, draftId);
    if (!draft) continue;
    const isReply = Boolean(draft.replyTo || draft.metadata.tweetType === "reply");
    const best = bestCandidate(db, draftId);
    if (!best) continue;
    const reasons = [...hardSlopReasons(best.text)];
    if (isReply && best.quality < generation.replyQualityMinimum()) {
      reasons.push(`reply_best_quality_below_floor (${best.quality} < ${generation.replyQualityMinimum()})`);
    } else if (!isReply && best.quality <= 3 && draft.metadata.sourcePacketId) {
      reasons.push(`machine_draft_quality_below_floor (<= 3)`);
    }
    if (reasons.length === 0) continue;
    const record = { at: new Date().toISOString(), action: "delete_draft", draftId, isReply, quality: best.quality, reasons, text: best.text.slice(0, 140) };
    if (dryRun) {
      logRecord({ ...record, dryRun: true });
      deleted += 1;
      continue;
    }
    try {
      await api(`/drafts/${draftId}`, { method: "DELETE" });
      deleted += 1;
      logRecord(record);
    } catch (error) {
      logRecord({ at: new Date().toISOString(), action: "delete_draft_failed", draftId, error: String(error) });
    }
  }
  return deleted;
}

async function auditPosted() {
  if (process.env.ZYQUOR_ENABLE_BROWSER_POST !== "1") {
    logRecord({ at: new Date().toISOString(), action: "posted_audit_skipped", reason: "browser delete is gated behind the post flag" });
    return 0;
  }
  const { history } = await api("/history");
  const now = Date.now();
  const fresh = history.filter((row) =>
    row.postedAt && now - Date.parse(row.postedAt) < 24 * 60 * 60 * 1000 &&
    !(row.metadata && row.metadata.deletedAt)
  );
  let deleted = 0;
  for (const row of fresh) {
    if (deleted >= maxPostDeletesPerCycle) break;
    const isReply = row.tweetType === "reply";
    const postText = row.postedText ?? "";
    const reasons = postedReasons(postText, isReply);
    if (reasons.length === 0) continue;
    const record = { at: new Date().toISOString(), action: "delete_posted", historyId: row.id, postUrl: row.postUrl, reasons, text: postText.slice(0, 140) };
    if (dryRun) {
      logRecord({ ...record, dryRun: true });
      deleted += 1;
      continue;
    }
    try {
      const result = await api(`/history/${row.id}/delete`, { method: "POST" });
      deleted += 1;
      logRecord({ ...record, alreadyDeleted: result?.alreadyDeleted ?? false });
    } catch (error) {
      logRecord({ at: new Date().toISOString(), action: "delete_posted_failed", historyId: row.id, error: String(error) });
    }
  }
  return deleted;
}

async function cycle() {
  const db = database();
  try {
    await api("/health");
  } catch (error) {
    logRecord({ at: new Date().toISOString(), action: "skip_cycle", reason: "api_unreachable", error: String(error) });
    return;
  }
  const queueDeleted = (await auditQueue(db)) + (await auditReviewQueue(db));
  const postedDeleted = await auditPosted();
  logRecord({ at: new Date().toISOString(), action: "cycle", queueDeleted, postedDeleted, dryRun });
}

if (once) {
  await cycle();
  process.exit(0);
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

while (true) {
  try {
    await cycle();
  } catch (error) {
    try {
      logRecord({ at: new Date().toISOString(), action: "cycle_error", error: String(error) });
    } catch {}
  }
  await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
}
