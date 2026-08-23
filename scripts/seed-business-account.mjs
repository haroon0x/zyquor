// Seeds a dedicated business X account with its own style profile.
//
// Usage:
//   node scripts/seed-business-account.mjs [handle] [display name...]
//
// Defaults to handle "business" when omitted. Safe to re-run (idempotent):
// existing rows are left untouched, so live edits made through the API or UI
// are never clobbered by a re-seed.
//
// The account is created in prepare_only mode on purpose: a business handle
// should review every draft manually before anything is posted.

import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const HANDLE_RE = /^[a-z0-9_]{1,15}$/;

const handle = process.argv[2] ?? "business";
if (!HANDLE_RE.test(handle)) {
  console.error(`Invalid handle "${handle}": must match ${HANDLE_RE}`);
  process.exit(1);
}
const displayName = process.argv.slice(3).join(" ").trim() || "Business";

function resolveDataRoot() {
  const root = process.env.ZYQUOR_DATA_ROOT ?? process.env.ZYQUOR_WORKSPACE_ROOT;
  return resolve(root ?? process.cwd());
}

// The API resolves its data root from cwd (apps/api when running normally),
// so discover the same candidates here instead of assuming one location.
function hasAccountsTable(path) {
  try {
    const probe = new DatabaseSync(path);
    const found = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get();
    probe.close();
    return Boolean(found);
  } catch {
    return false;
  }
}

function discoverDatabasePath() {
  const candidates = [
    process.env.ZYQUOR_DB_PATH,
    resolve(resolveDataRoot(), "data", "app.sqlite"),
    resolve(process.cwd(), "apps", "api", "data", "app.sqlite")
  ].filter(Boolean);
  return candidates.find((path) => existsSync(path) && hasAccountsTable(path)) ?? null;
}

const dbPath = discoverDatabasePath();
if (!dbPath) {
  console.error("No app.sqlite found. Set ZYQUOR_DB_PATH or run the app once first.");
  process.exit(1);
}
const dataRoot = resolve(dbPath, "..", "..");

let db;
try {
  db = new DatabaseSync(dbPath);
} catch (err) {
  console.error(`Cannot open database at ${dbPath}: ${err.message}`);
  console.error("Run the app once first so migrations/bootstrap have created it.");
  process.exit(1);
}

const timestamp = new Date().toISOString();

const BUSINESS_STYLE = {
  id: "style_business",
  name: "Business",
  description:
    "Professional brand voice for the business account: product updates, announcements, support replies, customer-facing notes.",
  tone: "professional, clear, helpful, concrete",
  objective:
    "Represent the brand credibly: inform customers and prospects, announce real product changes, answer questions precisely.",
  systemPromptExtra: [
    "You are writing as the official voice of a business, not as a personal account.",
    "Speak as 'we' only when describing the company's own product, decisions, and announcements; this is the one lane where 'we' is correct.",
    "Product claims must be verifiable from the supplied material. Never promise timelines, pricing, or features that were not supplied.",
    "Support replies: acknowledge the actual reported problem in one clause, then give the concrete next step or answer. Never argue with customers.",
    "Announcements: lead with what shipped or changed and who benefits; skip hype adjectives entirely.",
    "Stay courteous under all circumstances; humor allowed but never sarcasm directed at a person or competitor."
  ].join("\n"),
  bannedPhrases: [
    "game changer",
    "revolutionary",
    "best-in-class",
    "cutting-edge",
    "seamless",
    "synergy",
    "we're excited to announce",
    "thrilled to share"
  ],
  examplePosts: []
};

const BUSINESS_ACCOUNT = {
  id: "account_business",
  handle,
  displayName,
  profileDir: `profiles/${handle}`,
  styleProfileId: BUSINESS_STYLE.id,
  postingMode: "prepare_only"
};

const insertStyleProfile = db.prepare(
  `INSERT OR IGNORE INTO style_profiles (
     id, name, description, tone, rules_json, banned_phrases_json, example_posts_json, created_at, updated_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const styleResult = insertStyleProfile.run(
  BUSINESS_STYLE.id,
  BUSINESS_STYLE.name,
  BUSINESS_STYLE.description,
  BUSINESS_STYLE.tone,
  JSON.stringify({ objective: BUSINESS_STYLE.objective, systemPromptExtra: BUSINESS_STYLE.systemPromptExtra }),
  JSON.stringify(BUSINESS_STYLE.bannedPhrases),
  JSON.stringify(BUSINESS_STYLE.examplePosts),
  timestamp,
  timestamp
);

const insertAccount = db.prepare(
  `INSERT OR IGNORE INTO accounts (
     id, handle, display_name, profile_dir, style_profile_id, posting_mode, enabled,
     daily_post_limit, quiet_hours_start, quiet_hours_end, created_at, updated_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const accountResult = insertAccount.run(
  BUSINESS_ACCOUNT.id,
  BUSINESS_ACCOUNT.handle,
  BUSINESS_ACCOUNT.displayName,
  BUSINESS_ACCOUNT.profileDir,
  BUSINESS_ACCOUNT.styleProfileId,
  BUSINESS_ACCOUNT.postingMode,
  1,
  300,
  null,
  null,
  timestamp,
  timestamp
);

mkdirSync(resolve(dataRoot, BUSINESS_ACCOUNT.profileDir), { recursive: true });

db.close();

console.log(`Database: ${dbPath}`);
console.log(
  styleResult.changes > 0
    ? `Created style profile "${BUSINESS_STYLE.id}" (Business voice)`
    : `Style profile "${BUSINESS_STYLE.id}" already exists, kept current values`
);
console.log(
  accountResult.changes > 0
    ? `Created account "${BUSINESS_ACCOUNT.id}" (@${handle}, ${BUSINESS_ACCOUNT.postingMode}, profile dir ${BUSINESS_ACCOUNT.profileDir})`
    : `Account "${BUSINESS_ACCOUNT.id}" already exists, kept current values`
);
console.log(`Profile directory ready: ${resolve(dataRoot, BUSINESS_ACCOUNT.profileDir)}`);
console.log("");
console.log("Next steps:");
console.log(`  1. Log into @${handle}: pnpm profile:x  (then select the ${BUSINESS_ACCOUNT.profileDir} profile)`);
console.log("  2. Verify login: pnpm profile:x:check");
console.log("  3. Once you have real example tweets from the handle, add them:");
console.log("     PATCH /style-profiles/style_business { \"examplePosts\": [...] }");
