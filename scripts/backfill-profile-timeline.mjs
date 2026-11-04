import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { DatabaseSync } = await import("node:sqlite");
const crypto = await import("node:crypto");

const dryRun = process.argv.includes("--dry-run");
const maxTweets = Number(process.env.BACKFILL_MAX_TWEETS ?? 30);
function defaultDbPath() {
  if (process.env.ZYQUOR_DATA_ROOT) return resolve(process.env.ZYQUOR_DATA_ROOT, "data/app.sqlite");
  if (process.platform === "linux" && process.env.WSL_DISTRO_NAME) {
    const wslUser = process.env.USERPROFILE_USER || process.env.USER || "";
    return "/mnt/c/Users/" + wslUser + "/AppData/Roaming/Zyquor/data/app.sqlite";
  }
  return resolve(new URL("..", import.meta.url).pathname, "data/app.sqlite");
}
const dbPath = process.env.ZYQUOR_MENTIONS_DB ?? defaultDbPath();

function cdpUrlForProfile(profileDir, baseUrl) {
  const base = baseUrl ?? "http://127.0.0.1:9222";
  try {
    const url = new URL(base);
    const basePort = Number(url.port || 9222);
    const normalized = profileDir.replaceAll("\\", "/").toLowerCase();
    let offset = 0;
    if (normalized.includes("willainotice")) offset = 1;
    else if (!normalized.includes("personal-main")) {
      let h = 0;
      for (let i = 0; i < normalized.length; i++) h = (h * 31 + normalized.charCodeAt(i)) % 10;
      offset = h;
    }
    url.port = String(basePort + offset);
    return url.toString().replace(/\/$/, "");
  } catch { return base; }
}

function baseCdpUrl() {
  if (process.env.ZYQUOR_BROWSER_CDP_URL) return process.env.ZYQUOR_BROWSER_CDP_URL;
  const isWsl = process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME);
  return "http://127.0.0.1:9222";
}

const db = new DatabaseSync(dbPath);
const accounts = db.prepare("SELECT id, handle, profile_dir FROM accounts WHERE enabled=1").all();
console.log(`Found ${accounts.length} enabled accounts`);
for (const acc of accounts) console.log(` - ${acc.handle} ${acc.id} ${acc.profile_dir}`);

let browserModule;
try {
  browserModule = await import("../packages/browser/dist/index.js");
} catch (e) {
  console.error("Cannot import @zyquor/browser", e.message);
  try {
    const r = createRequire(new URL("../packages/browser/package.json", import.meta.url));
    browserModule = r("../packages/browser/dist/index.js");
  } catch (e2) {
    console.error(e2.message);
    process.exit(1);
  }
}

for (const acc of accounts) {
  const profileDir = acc.profile_dir;
  const cdpUrl = cdpUrlForProfile(profileDir, baseCdpUrl());
  console.log(`\n[${acc.handle}] profile=${profileDir} cdp=${cdpUrl} maxTweets=${maxTweets}${dryRun ? " DRY_RUN" : ""}`);
  try {
    await browserModule.ensureBrowserCdp(cdpUrl, profileDir);
  } catch (e) {
    console.error(`  ensureBrowserCdp failed for @${acc.handle}: ${e.message.slice(0, 200)}`);
  }
  let timeline;
  try {
    timeline = await browserModule.fetchAccountTimeline({
      profileDir,
      handle: acc.handle,
      cdpUrl,
      maxTweets,
      scrolls: 10,
    });
  } catch (e) {
    console.error(`  fetch failed for @${acc.handle}: ${e.message.slice(0, 300)}`);
    continue;
  }
  console.log(`  fetched ${timeline.tweets.length} tweets for @${acc.handle}`);
  if (timeline.tweets.length === 0) continue;

  const examples = timeline.tweets.filter(t => t.authorHandle.toLowerCase() === acc.handle.toLowerCase() && !t.isRetweet).slice(0, 5).map(t => t.text);
  if (examples.length > 0 && !dryRun) {
    const row = db.prepare("SELECT id, example_posts_json FROM style_profiles WHERE id=(SELECT style_profile_id FROM accounts WHERE id=?)").get(acc.id);
    if (row) {
      const merged = [...new Set([...examples, ...JSON.parse(row.example_posts_json ?? "[]")])].slice(0, 5);
      db.prepare("UPDATE style_profiles SET example_posts_json=?, updated_at=? WHERE id=?").run(JSON.stringify(merged), new Date().toISOString(), row.id);
      console.log(`  updated style_profile ${row.id} with ${examples.length} examples`);
    }
  } else if (dryRun) {
    console.log(`  would update style_profile with examples:`, examples.slice(0, 2).map(s => s.slice(0, 60)));
  }

  let inserted = 0;
  for (const tweet of timeline.tweets.filter(t => t.authorHandle.toLowerCase() === acc.handle.toLowerCase() && !t.isRetweet)) {
    const tweetId = tweet.url.split("/").pop()?.split("?")[0] ?? tweet.id;
    if (!/^\d+$/.test(tweetId)) continue;
    if (dryRun) { inserted++; continue; }
    try {
      const existing = db.prepare("SELECT measured_at FROM tweet_measurements WHERE account_id=? AND tweet_id=?").get(acc.id, tweetId);
      if (existing) continue;
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO tweet_measurements (id, account_id, tweet_id, origin, posted_at, text, has_link, source_type, tweet_type, views, likes, replies, reposts, bookmarks, measured_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        `measurement_${crypto.randomUUID()}`,
        acc.id,
        tweetId,
        "external",
        tweet.publishedAt ?? null,
        tweet.text,
        tweet.hasLink ? 1 : 0,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        now,
        now
      );
      inserted++;
    } catch (e) {
      console.error(`  insert failed ${tweet.url}: ${e.message}`);
    }
  }
  console.log(`  inserted ${inserted} new tweet_measurements for @${acc.handle}`);
}

if (!dryRun) console.log("\nBackfill complete");
else console.log("\nDry-run complete");
