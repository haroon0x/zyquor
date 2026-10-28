#!/usr/bin/env node
// Original post runner.
//
// Generates standalone posts from a rotating topic bank, screens the
// candidates with the deterministic filter below, and posts the best one
// through the normal gated draft, approve, and job path. Replies have their
// own runner (scripts/reply-loop.mjs); this one only posts originals.
//
// The daily cap and spacing are computed from the server's post history, not
// from local counters, so a restart cannot push the account past its limit.
//
// Usage:
//   node scripts/post-loop.mjs --once --dry   # draft and report, no approval
//   node scripts/post-loop.mjs --once         # post now if under the daily cap
//   node scripts/post-loop.mjs                # run forever
//   node scripts/post-loop.mjs --once --force # ignore the daily cap
//
// Env:
//   ZYQUOR_API_URL                    default http://127.0.0.1:3001
//   ZYQUOR_POST_ACCOUNT_ID            default account_personal
//   ZYQUOR_POST_LOOP_PER_DAY          default 5
//   ZYQUOR_POST_LOOP_START_HOUR       default 9 (account local time)
//   ZYQUOR_POST_LOOP_END_HOUR         default 22 (account local time)
//   ZYQUOR_POST_LOOP_UTC_OFFSET_MIN   default 330 (IST)
//   ZYQUOR_POST_LOOP_MIN_QUALITY      default 7
//   ZYQUOR_POST_LOOP_CANDIDATES       default 4
//   ZYQUOR_POST_LOOP_MIN_GAP_MIN      default 20, gap after the last original

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const dry = args.has("--dry");
const force = args.has("--force");

const configuredApiUrl = (process.env.ZYQUOR_API_URL ?? "").replace(/\/$/, "");
const accountId = process.env.ZYQUOR_POST_ACCOUNT_ID ?? "account_personal";
const perDay = clamp(Number(process.env.ZYQUOR_POST_LOOP_PER_DAY ?? 5), 1, 10);
const startHour = clamp(Number(process.env.ZYQUOR_POST_LOOP_START_HOUR ?? 9), 0, 23);
const endHour = clamp(Number(process.env.ZYQUOR_POST_LOOP_END_HOUR ?? 22), 1, 24);
const tzOffsetMin = Number(process.env.ZYQUOR_POST_LOOP_UTC_OFFSET_MIN ?? 330);
const minQuality = clamp(Number(process.env.ZYQUOR_POST_LOOP_MIN_QUALITY ?? 7), 0, 10);
const candidateCount = clamp(Number(process.env.ZYQUOR_POST_LOOP_CANDIDATES ?? 4), 1, 8);
const minGapMs = clamp(Number(process.env.ZYQUOR_POST_LOOP_MIN_GAP_MIN ?? 20), 0, 600) * 60_000;

const dataDir = join(repoRoot, "apps/api/data");
const statePath = join(dataDir, "post-loop-state.json");
const logPath = join(dataDir, "post-loop.jsonl");
mkdirSync(dataDir, { recursive: true });

// Angles the account can defend without fresh research. The model still writes
// the post; these only set the subject, so a weak seed cannot invent a claim.
// Add or remove entries freely, the rotation is least-recently-used.
const TOPIC_BANK = [
  { tweetType: "opinion", idea: "Coding agents are judged on the diff, but the expensive failures come from a wrong assumption that still compiles." },
  { tweetType: "useful_info", idea: "Per-account browser profiles are the simple fix for parallel posting from one machine." },
  { tweetType: "guide", idea: "How to verify a coding agent actually did the work instead of trusting its summary." },
  { tweetType: "opinion", idea: "Local-first is a data ownership decision before it is a sync architecture decision." },
  { tweetType: "useful_info", idea: "In agent workflows the review step is the bottleneck, not generation." },
  { tweetType: "opinion", idea: "Most self-hosted setups fail on upgrades, not on the first install." },
  { tweetType: "useful_info", idea: "Why one stable CDP port per account beats one shared browser for posting automation." },
  { tweetType: "opinion", idea: "A model benchmark without the raw runs stops being useful the day the next model ships." },
  { tweetType: "guide", idea: "What to log from a coding agent if you want to audit it a week later." },
  { tweetType: "opinion", idea: "Context windows grew, but the discipline of feeding less still wins." },
  { tweetType: "useful_info", idea: "Postgres connection pool saturation looks like slow queries under load." },
  { tweetType: "opinion", idea: "Headless automation is a reliability decision, not a stealth decision." },
  { tweetType: "guide", idea: "A small checklist before letting an agent touch a production repo." },
  { tweetType: "opinion", idea: "Open weights matter most where the data cannot leave the building." },
  { tweetType: "useful_info", idea: "Reply discovery should start from the home feed and fall back to search only when the feed is thin." },
  { tweetType: "opinion", idea: "The timeline rewards one clear claim more than a balanced list." },
  { tweetType: "guide", idea: "How to keep a posting bot from sounding like a bot." },
  { tweetType: "opinion", idea: "Agent worktrees solve file conflicts, not review conflicts." },
  { tweetType: "useful_info", idea: "What a daily posting limit actually protects." },
  { tweetType: "opinion", idea: "Most launch advice ignores the part where distribution is chosen before the launch post." },
  { tweetType: "useful_info", idea: "A failed job should keep the error and the screenshot, not just a status." },
  { tweetType: "opinion", idea: "A benchmark you cannot rerun is a press release with a table." },
  { tweetType: "guide", idea: "How to run two X accounts on one machine without one browser stealing the other's session." },
  { tweetType: "opinion", idea: "The hardest part of automation is not the happy path, it is deciding what happens after a half finished post." },
  { tweetType: "useful_info", idea: "Why quiet hours belong in the posting loop, not only in the UI." }
];

const SLOP_WORDS = /\b(delve|leverage|seamless|robust|game.?changer|unlock|revolutionary|journey|ecosystem|quiet upside|mind.?blowing|synergy)\b/i;
const FORMULA_A = /\b(?:isn'?t|aren'?t|wasn'?t|doesn'?t|don'?t|won'?t|can'?t)\b[^.!?]{0,80}\b(?:it'?s|it is|that'?s|they'?re|the real)\b/i;
const FORMULA_B = /\bnot\b[^.!?]{0,50}\bbut\b/i;
const REAL_X = /\bthe real \w+ is\b/i;
const PARALLEL = /\b(?:knows|does|is|has|can|will)\b[^.!?]{0,60},\s*(?:the\s+|and\s+the\s+)?\w+\s+(?:doesn'?t|isn'?t|hasn'?t|won'?t|can'?t)\b/i;
const EXPERIENCE_CLAIM = /\b(?:i(?:'ve| have)?\s+(?:used|run|shipped|built|tried|migrated|deployed|maintained|worked)|in my (?:experience|team|company)|at my (?:company|last job)|we (?:use|run|shipped|built|tried)|when i (?:ran|tried|used)|my team (?:uses|runs|shipped))\b/i;

let apiUrl = configuredApiUrl || "http://127.0.0.1:3001";

function clamp(value, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}

function log(message) {
  const line = `[post-loop ${new Date().toISOString().slice(11, 19)}] ${message}`;
  console.log(line);
  try {
    appendFileSync(join(dataDir, "post-loop.log"), `${line}\n`);
  } catch {
    // logging must never stop posting
  }
}

function record(entry) {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function readState() {
  if (!existsSync(statePath)) return { topics: {}, recentTexts: [] };
  try {
    return { topics: {}, recentTexts: [], ...JSON.parse(readFileSync(statePath, "utf8")) };
  } catch {
    return { topics: {}, recentTexts: [] };
  }
}

function saveState(state) {
  state.recentTexts = (state.recentTexts ?? []).slice(-25);
  writeFileSync(statePath, JSON.stringify(state, null, 1));
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
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

// Account local time, independent of the host or WSL clock settings.
function localNow(ms = Date.now()) {
  return new Date(ms + tzOffsetMin * 60_000);
}

function localDayKey(ms = Date.now()) {
  return localNow(ms).toISOString().slice(0, 10);
}

function localMidnightMs(ms = Date.now()) {
  const local = localNow(ms);
  const utcMidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return utcMidnight - tzOffsetMin * 60_000;
}

function hourToMs(hour) {
  return hour * 3_600_000;
}

function nextDayStartMs(ms = Date.now()) {
  return localMidnightMs(ms) + 24 * 3_600_000 + hourToMs(startHour);
}

function postReasons(text, idea) {
  const t = text.trim();
  const reasons = [];
  if (t.length < 180) reasons.push("too_short");
  if (t.length > 620) reasons.push("too_long");
  if (!/^[A-Z0-9]/.test(t)) reasons.push("lowercase_opener");
  if (t.includes("?")) reasons.push("question_bait");
  if (/#\w|(?:^|\s)@\w/.test(t)) reasons.push("hashtag_or_mention");
  if (/https?:\/\//i.test(t)) reasons.push("has_link");
  if (/[\u2013\u2014]/.test(t)) reasons.push("dash");
  if (SLOP_WORDS.test(t)) reasons.push("slop_word");
  if (FORMULA_A.test(t) || FORMULA_B.test(t) || REAL_X.test(t) || PARALLEL.test(t)) reasons.push("formula_contrast");
  if (EXPERIENCE_CLAIM.test(t)) reasons.push("invented_experience");
  const stats = (t.match(/(?:\$\s?\d[\d,.]*|\d+(?:\.\d+)?\s?%|\b\d{3,}\b)/g) ?? [])
    .filter((value) => !/^(?:19|20)\d{2}$/.test(value.replace(/[^\d]/g, "")));
  const known = new Set(idea.match(/(?:\$\s?\d[\d,.]*|\d+(?:\.\d+)?\s?%|\b\d{3,}\b)/g) ?? []);
  if (stats.some((value) => !known.has(value))) reasons.push("invented_stat");
  return reasons;
}

function pickCandidate(candidates, idea, state) {
  const scored = candidates.map((candidate) => {
    const reasons = postReasons(candidate.text, idea);
    const signature = candidate.text.trim().toLowerCase().slice(0, 120);
    if ((state.recentTexts ?? []).includes(signature)) reasons.push("repeat");
    return { candidate, reasons };
  });
  const clean = scored.filter(
    (row) => row.reasons.length === 0 && Number(row.candidate.score?.quality ?? 0) >= minQuality
  );
  clean.sort((a, b) => Number(b.candidate.score.quality) - Number(a.candidate.score.quality));
  return { scored, chosen: clean[0] ?? null };
}

function pickTopic(state) {
  const used = state.topics ?? {};
  const candidates = TOPIC_BANK.map((topic) => ({
    ...topic,
    lastUsed: Date.parse(used[topic.idea]?.at ?? 0) || 0
  }));
  candidates.sort((a, b) => a.lastUsed - b.lastUsed);
  return candidates[0];
}

async function postHistory() {
  const body = await api("/performance", {}, 15_000);
  return (body?.history ?? [])
    .map((row) => ({
      tweetType: row.tweetType ?? "post",
      postedAt: Date.parse(row.postedAt ?? "")
    }))
    .filter((row) => Number.isFinite(row.postedAt));
}

// Returns 0 when a post is due now, or the milliseconds to wait.
function waitForSlot(history) {
  const now = Date.now();
  const today = localDayKey(now);
  const originalsToday = history.filter(
    (row) => row.tweetType !== "reply" && localDayKey(row.postedAt) === today
  );
  const lastOriginal = history.reduce(
    (max, row) => (row.tweetType === "reply" ? max : Math.max(max, row.postedAt)),
    0
  );

  if (!force && !dry && originalsToday.length >= perDay) {
    return Math.max(60_000, nextDayStartMs(now) - now);
  }

  const dayStart = localMidnightMs(now);
  const windowMs = hourToMs(endHour - startHour);
  const intervalMs = windowMs / perDay;
  const slot = dayStart + hourToMs(startHour) + originalsToday.length * intervalMs;
  const windowEnd = dayStart + hourToMs(endHour);

  if (now > windowEnd && !force) {
    return Math.max(60_000, nextDayStartMs(now) - now);
  }

  // A late start must not burn through the day's quota in one burst. Each post
  // also waits a full interval after the previous original.
  const dueAt = Math.max(slot, lastOriginal > 0 ? lastOriginal + intervalMs : 0, lastOriginal + minGapMs);
  if (now < dueAt) {
    const jitter = ((originalsToday.length + 1) * 37) % 11;
    return dueAt - now + jitter * 60_000;
  }
  return 0;
}

async function sleepUntil(targetMs) {
  while (Date.now() < targetMs && !stopping) {
    await sleep(Math.min(30_000, Math.max(1_000, targetMs - Date.now())));
  }
}

let stopping = false;

async function runCycle(state, history) {
  const originalsToday = history.filter(
    (row) => row.tweetType !== "reply" && localDayKey(row.postedAt) === localDayKey()
  );
  if (!force && !dry && originalsToday.length >= perDay) {
    log(`daily cap reached (${originalsToday.length}/${perDay})`);
    return 0;
  }

  const topic = pickTopic(state);
  log(`drafting ${topic.tweetType}: ${topic.idea.slice(0, 80)}`);

  let draftId = null;
  let candidates = [];
  try {
    const created = await api("/drafts", {
      method: "POST",
      body: JSON.stringify({
        accountId,
        idea: topic.idea,
        tweetType: topic.tweetType,
        count: candidateCount
      })
    }, 30_000);
    draftId = created?.draft?.id;
    if (!draftId) throw new Error("no draft id returned");
    const generated = await api(`/drafts/${draftId}/generate`, { method: "POST", body: JSON.stringify({}) }, 420_000);
    candidates = generated?.candidates ?? [];
  } catch (error) {
    const reason = `draft_failed:${String(error.message).slice(0, 100)}`;
    record({ at: new Date().toISOString(), idea: topic.idea, tweetType: topic.tweetType, draftId, decision: "error", reason });
    log(`  ${reason}`);
    return 0;
  }

  const { scored, chosen } = pickCandidate(candidates, topic.idea, state);
  state.topics = state.topics ?? {};
  state.topics[topic.idea] = { at: new Date().toISOString(), draftId, decision: chosen ? "chosen" : "review" };
  saveState(state);

  record({
    at: new Date().toISOString(),
    idea: topic.idea,
    tweetType: topic.tweetType,
    draftId,
    decision: chosen ? "candidate_chosen" : "queue_for_review",
    chosen: chosen ? { text: chosen.candidate.text, quality: chosen.candidate.score?.quality } : null,
    rejected: scored
      .filter((row) => !chosen || row.candidate.id !== chosen.candidate.id)
      .map((row) => ({
        text: row.candidate.text.slice(0, 200),
        quality: row.candidate.score?.quality,
        reasons: row.reasons
      }))
  });

  if (!chosen) {
    log(`  no candidate passed the screen (${candidates.length} drafted, kept for review)`);
    return 0;
  }

  log(`  chosen q${chosen.candidate.score.quality}: ${chosen.candidate.text.slice(0, 90)}`);
  if (dry) {
    log("  dry run, not approving");
    return 0;
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
    const signature = chosen.candidate.text.trim().toLowerCase().slice(0, 120);
    state.recentTexts = [...(state.recentTexts ?? []), signature];
    saveState(state);
    record({
      at: new Date().toISOString(),
      idea: topic.idea,
      tweetType: topic.tweetType,
      draftId,
      decision: "posted",
      jobId,
      postUrl
    });
    log(`  POSTED ${postUrl ?? "(no url)"}`);
    return 1;
  } catch (error) {
    const reason = `post_failed:${String(error.message).slice(0, 120)}`;
    record({ at: new Date().toISOString(), idea: topic.idea, tweetType: topic.tweetType, draftId, decision: "error", reason });
    log(`  ${reason}`);
    return 0;
  }
}

async function main() {
  apiUrl = await resolveApiUrl();
  const version = await api("/health", {}, 5_000).catch(() => null);
  log(`api ${apiUrl} model=${version?.generation?.model ?? "unknown"} perDay=${perDay} dry=${dry} once=${once}`);

  const state = readState();
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  do {
    try {
      const history = await postHistory();
      const waitMs = force ? 0 : waitForSlot(history);
      if (waitMs > 0 && !once) {
        log(`next post in ${Math.round(waitMs / 60_000)} min`);
        await sleepUntil(Date.now() + waitMs);
        continue;
      }
      const posted = await runCycle(state, history);
      log(`cycle done, posted ${posted}`);
    } catch (error) {
      log(`cycle crashed: ${String(error).split("\n")[0].slice(0, 200)}`);
      // A dead API should not spin. Wait a minute before trying again.
      if (!once) await sleep(60_000);
    }
    if (once || stopping) break;
  } while (!stopping);
}

await main();
