#!/usr/bin/env node
// Posts-only reply runner.
//
// Discovers reply targets from X search (through the already logged-in Chrome
// profile) and the home feed, drafts best-of-N via the Zyquor API, screens the
// candidates with the deterministic slop filter below, and only then approves
// (screened:true) and posts through the normal gated job path. Mentions are
// deliberately not part of this loop.
//
// The filter is the learning surface: every rejection is logged with a reason,
// so prompt rules only get added when a reason repeats, never speculatively.
//
// Usage:
//   node scripts/reply-loop.mjs --once --dry     # discover + draft + report, no approval
//   node scripts/reply-loop.mjs --once           # one full cycle, may post
//   node scripts/reply-loop.mjs                  # run forever (interval below)
//
// Env:
//   ZYQUOR_API_URL                  default http://127.0.0.1:3001
//   ZYQUOR_REPLY_LOOP_INTERVAL_MS   default 12 min
//   ZYQUOR_REPLY_LOOP_QUERIES      comma separated search queries
//   ZYQUOR_REPLY_LOOP_MAX_POSTS    posts per cycle, default 1
//   ZYQUOR_REPLY_LOOP_MIN_QUALITY  auto-post floor, default 6

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const requireBrowser = createRequire(join(repoRoot, "packages/browser/package.json"));
const { chromium } = requireBrowser("playwright-core");

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dry = args.has("--dry");

const configuredApiUrl = (process.env.ZYQUOR_API_URL ?? "").replace(/\/$/, "");
const accountId = process.env.ZYQUOR_REPLY_ACCOUNT_ID ?? "account_personal";
const cdpUrl = process.env.ZYQUOR_BROWSER_CDP_URL ?? "http://172.31.96.1:9223";
const intervalMs = Number(process.env.ZYQUOR_REPLY_LOOP_INTERVAL_MS ?? 12 * 60 * 1000);
const maxPosts = Number(process.env.ZYQUOR_REPLY_LOOP_MAX_POSTS ?? 1);
const minQuality = Number(process.env.ZYQUOR_REPLY_LOOP_MIN_QUALITY ?? 6);
const count = Number(process.env.ZYQUOR_REPLY_LOOP_CANDIDATES ?? 5);

let apiUrl = configuredApiUrl || "http://127.0.0.1:3001";
const dataDir = join(repoRoot, "apps/api/data");
const statePath = join(dataDir, "reply-loop-state.json");
const logPath = join(dataDir, "reply-loop.jsonl");
mkdirSync(dataDir, { recursive: true });

const DEFAULT_QUERIES = [
  "coding agents",
  "claude code",
  "ai agents",
  "self hosted",
  "postgres",
  "local first"
];

const BAIT = /\b(who should i follow|drop your|say hi|tag someone|what are you building|am i the only|follow train|engagement)\b/i;
const ADVICE = /\b(you should|you need to|you'?ll want to|make sure|be sure to|try to|consider|just use|worth a look|worth checking|start with|avoid)\b/i;
const FORMULA_A = /\b(?:isn'?t|aren'?t|wasn'?t|doesn'?t|don'?t|won'?t|can'?t)\b[^.!?]{0,80}\b(?:it'?s|it is|that'?s|they'?re|the real)\b/i;
const FORMULA_B = /\bnot\b[^.!?]{0,50}\bbut\b/i;
const REAL_X = /\bthe real \w+ is\b/i;
const PARALLEL = /\b(?:knows|does|is|has|can|will)\b[^.!?]{0,60},\s*(?:the\s+|and\s+the\s+)?\w+\s+(?:doesn'?t|isn'?t|hasn'?t|won'?t|can'?t)\b/i;
const SLOP_WORDS = /\b(delve|leverage|seamless|robust|game.?changer|unlock|revolutionary|journey|ecosystem|quiet upside)\b/i;
const FIRST_PERSON = /\b(I|I'm|I've|I'd|my|me)\b/;

function log(message) {
  console.log(`[reply-loop ${new Date().toISOString().slice(11, 19)}] ${message}`);
}

function readState() {
  if (!existsSync(statePath)) return { seen: {}, authors: [], queryIndex: 0 };
  try {
    return { seen: {}, authors: [], queryIndex: 0, ...JSON.parse(readFileSync(statePath, "utf8")) };
  } catch {
    return { seen: {}, authors: [], queryIndex: 0 };
  }
}

function saveState(state) {
  const entries = Object.entries(state.seen).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 400);
  state.seen = Object.fromEntries(entries);
  writeFileSync(statePath, JSON.stringify(state, null, 1));
}

function record(entry) {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function markSeen(state, url, reason, extra = {}) {
  state.seen[url] = { at: new Date().toISOString(), reason, ...extra };
  saveState(state);
}

async function api(path, init = {}, timeoutMs = 180_000) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    ...(init.body ? { headers: { "content-type": "application/json", ...init.headers } } : {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error ?? `HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function health() {
  return api("/health", {}, 5_000);
}

async function resolveApiUrl() {
  if (configuredApiUrl) return configuredApiUrl;
  for (const candidate of ["http://127.0.0.1:3001", "http://127.0.0.1:3000"]) {
    try {
      const response = await fetch(`${candidate}/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return candidate;
    } catch {
      // try next port
    }
  }
  return apiUrl;
}

function slopReasons(text, target) {
  const t = text.trim();
  const reasons = [];
  if (t.length < 60) reasons.push("too_short");
  if (t.length > 279) reasons.push("too_long");
  if (t.includes("?") && !target.includes("?")) reasons.push("question_not_asked");
  if (ADVICE.test(t)) reasons.push("advice");
  if (FORMULA_A.test(t) || FORMULA_B.test(t) || REAL_X.test(t) || PARALLEL.test(t)) reasons.push("formula_contrast");
  if (SLOP_WORDS.test(t)) reasons.push("slop_word");
  const numbers = t.match(/\d+(?:\.\d+)?/g) ?? [];
  const known = new Set(target.match(/\d+(?:\.\d+)?/g) ?? []);
  if (numbers.some((n) => !known.has(n))) reasons.push("invented_number");
  if (FIRST_PERSON.test(t)) reasons.push("first_person_review");
  return reasons;
}

function acceptableTarget(item) {
  const text = (item.text ?? "").trim();
  if (text.length < 70) return "thin_text";
  if (/https?:\/\//i.test(text)) return "has_link";
  if (BAIT.test(text)) return "bait";
  if (/^@/.test(text)) return "reply_shaped";
  return null;
}

async function searchTargets(queries) {
  const found = [];
  for (const query of queries) {
    const full = `${query} -filter:replies lang:en`;
    let browser;
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      const ctx = browser.contexts()[0];
      const page = await ctx.newPage();
      try {
        await page.goto("https://x.com/explore", { waitUntil: "domcontentloaded", timeout: 45_000 });
        await page.waitForTimeout(2_500);
        const shellText = await page.evaluate(() => (document.body?.innerText ?? "").trim());
        if (!shellText) throw new Error("x_splash_no_render");
        const box = page.locator("input[data-testid='SearchBox_Search_Input']").first();
        await box.waitFor({ timeout: 15_000 });
        await box.click();
        await box.fill(full);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(6_500);
        const latest = page.getByRole("tab", { name: /latest/i }).first();
        if (await latest.count()) {
          await latest.click().catch(() => {});
          await page.waitForTimeout(3_500);
        }
        await page.mouse.wheel(0, 1800);
        await page.waitForTimeout(2_000);
        const rows = await page.evaluate(() =>
          Array.from(document.querySelectorAll("article[data-testid='tweet']")).map((article) => {
            const link = article.querySelector("a[href*='/status/']");
            const text = article.querySelector("[data-testid='tweetText']");
            const time = article.querySelector("time");
            const handle = article.querySelector("[data-testid='User-Name'] a[href^='/']");
            return {
              url: link ? new URL(link.getAttribute("href"), "https://x.com").toString() : "",
              text: text ? text.innerText.replace(/\s+/g, " ").trim() : "",
              at: time ? time.getAttribute("datetime") : "",
              author: handle ? handle.getAttribute("href").replace("/", "") : ""
            };
          }).filter((row) => row.url && row.text)
        );
        log(`search "${full}": ${rows.length} rows`);
        found.push(...rows);
      } finally {
        await page.close().catch(() => {});
      }
    } catch (error) {
      log(`search "${query}" failed: ${String(error).split("\n")[0].slice(0, 120)}`);
    } finally {
      await browser?.close().catch(() => {});
    }
  }
  return found;
}

async function feedTargets() {
  try {
    const body = await api(`/replies/feed?accountId=${accountId}`, {}, 200_000);
    const rows = body?.tweets ?? [];
    log(`feed: ${rows.length} rows`);
    return rows.map((row) => ({ ...row, author: row.authorHandle ?? row.author ?? "" }));
  } catch (error) {
    log(`feed failed: ${String(error).slice(0, 120)}`);
    return [];
  }
}

function pickCandidate(candidates, target) {
  const scored = candidates.map((candidate) => ({
    candidate,
    reasons: slopReasons(candidate.text, target)
  }));
  const clean = scored.filter((row) => row.reasons.length === 0 && Number(row.candidate.score?.quality ?? 0) >= minQuality);
  clean.sort((a, b) => Number(b.candidate.score.quality) - Number(a.candidate.score.quality));
  return { scored, chosen: clean[0] ?? null };
}

async function runCycle(state) {
  const configured = process.env.ZYQUOR_REPLY_LOOP_QUERIES?.split(",").map((q) => q.trim()).filter(Boolean);
  const pool = configured?.length ? configured : DEFAULT_QUERIES;
  const start = state.queryIndex % pool.length;
  const queries = [pool[start], pool[(start + 1) % pool.length]];
  state.queryIndex = (start + 2) % pool.length;

  // Sequential on purpose: the feed scan goes through the API, which owns and
  // closes its own browser context. Running search concurrently with it kills
  // the search page mid-navigation.
  const feed = await feedTargets();
  const search = await searchTargets(queries);
  const all = [...search, ...feed].filter((row) => row.url && row.text);
  const seenAuthors = new Set(state.authors.slice(-3));
  let posted = 0;

  for (const item of all) {
    if (posted >= maxPosts) break;
    if (state.seen[item.url]) continue;
    if (item.author?.toLowerCase() === "haroon0x") continue;
    if (seenAuthors.has(item.author?.toLowerCase())) continue;
    const targetReason = acceptableTarget(item);
    if (targetReason) {
      markSeen(state, item.url, targetReason);
      record({ at: new Date().toISOString(), url: item.url, author: item.author, decision: "skip_target", reason: targetReason });
      continue;
    }

    log(`drafting ${item.author} ${item.url}`);
    let draftBody;
    try {
      draftBody = await api("/replies/from-url", {
        method: "POST",
        body: JSON.stringify({ accountId, url: item.url, count, useMemory: false })
      }, 400_000);
    } catch (error) {
      const reason = `draft_failed:${String(error.message).slice(0, 80)}`;
      markSeen(state, item.url, reason);
      record({ at: new Date().toISOString(), url: item.url, author: item.author, decision: "skip_target", reason });
      log(`  ${reason}`);
      continue;
    }

    const draftId = draftBody?.draft?.id;
    const candidates = draftBody?.candidates ?? [];
    const { scored, chosen } = pickCandidate(candidates, item.text);
    record({
      at: new Date().toISOString(),
      url: item.url,
      author: item.author,
      draftId,
      decision: chosen ? "candidate_chosen" : "queue_for_review",
      chosen: chosen ? { text: chosen.candidate.text, quality: chosen.candidate.score?.quality } : null,
      rejected: scored.filter((row) => !chosen || row.candidate.id !== chosen.candidate.id)
        .map((row) => ({ text: row.candidate.text.slice(0, 160), quality: row.candidate.score?.quality, reasons: row.reasons }))
    });

    if (!chosen) {
      markSeen(state, item.url, "no_candidate_passed_screen");
      log(`  no candidate passed the screen (${candidates.length} drafted, kept for review)`);
      continue;
    }

    log(`  chosen q${chosen.candidate.score.quality}: ${chosen.candidate.text.slice(0, 90)}`);
    if (dry) {
      log("  dry run, not approving");
      continue;
    }

    try {
      await api(`/drafts/${draftId}/select`, {
        method: "POST",
        body: JSON.stringify({ candidateId: chosen.candidate.id })
      }, 30_000);
      const approved = await api(`/drafts/${draftId}/approve`, {
        method: "POST",
        body: JSON.stringify({ editedText: chosen.candidate.text, screened: true, mode: "review_required" })
      }, 30_000);
      const jobId = approved?.job?.id;
      if (!jobId) throw new Error("no job returned");
      const postResult = await api(`/jobs/${jobId}/post`, { method: "POST" }, 420_000);
      const postUrl = postResult?.history?.postUrl ?? null;
      markSeen(state, item.url, "posted", { postUrl });
      state.authors = [...state.authors.slice(-19), item.author?.toLowerCase()];
      record({ at: new Date().toISOString(), url: item.url, author: item.author, draftId, decision: "posted", jobId, postUrl });
      log(`  POSTED ${postUrl ?? "(no url)"}`);
      posted += 1;
    } catch (error) {
      const reason = `post_failed:${String(error.message).slice(0, 120)}`;
      markSeen(state, item.url, reason);
      record({ at: new Date().toISOString(), url: item.url, author: item.author, draftId, decision: "error", reason });
      log(`  ${reason}`);
      if (error.status === 429) break;
    }
  }

  saveState(state);
  return posted;
}

async function main() {
  apiUrl = await resolveApiUrl();
  const version = await health().catch(() => null);
  log(`api ${apiUrl} model=${version?.generation?.model ?? "unknown"} dry=${dry} once=${once}`);
  const state = readState();
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });

  do {
    try {
      const posted = await runCycle(state);
      log(`cycle done, posted ${posted}`);
    } catch (error) {
      log(`cycle crashed: ${String(error).split("\n")[0].slice(0, 200)}`);
    }
    if (once || stopping) break;
    log(`sleeping ${Math.round(intervalMs / 60000)} min`);
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (!stopping);
}

await main();
