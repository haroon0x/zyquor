import { postPerformanceFromMetadata, withPostPerformance, type PostHistory } from "@zyquor/core";
import type { ZyquorRepository } from "@zyquor/storage";
import type { AppDeps } from "../deps.js";
import { browserOptions } from "./browser.js";
import { resolveProfileDir } from "./paths.js";

// The learning loop is data-starved by design otherwise: at personal-account
// volumes every measured post matters, so measure all pending posts each pass
// and re-measure after 6h instead of 12h to catch early velocity.
const MIN_AGE_HOURS = Number(process.env.ZYQUOR_PERFORMANCE_MIN_AGE_HOURS ?? 2);
const REFETCH_AFTER_HOURS = Number(process.env.ZYQUOR_PERFORMANCE_REFETCH_HOURS ?? 6);
const MAX_PER_REFRESH = Number(process.env.ZYQUOR_PERFORMANCE_MAX_PER_REFRESH ?? 8);

function hoursAgoIso(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function tweetIdFromPostUrl(postUrl: string | null): string | null {
  if (!postUrl) return null;
  const match = /\/status\/(\d+)\/?$/.exec(postUrl);
  return match?.[1] ?? null;
}

function tweetIdFromUrl(url: string): string | null {
  const match = /\/(\d+)\/?$/.exec(url);
  return match?.[1] ?? null;
}

function needsMeasurement(history: PostHistory, nowIso: string): boolean {
  if (!tweetIdFromPostUrl(history.postUrl)) return false;
  if (history.postedAt > hoursAgoIso(MIN_AGE_HOURS)) return false;
  const existing = postPerformanceFromMetadata(history.metadata);
  if (!existing) return true;
  return existing.measuredAt < hoursAgoIso(REFETCH_AFTER_HOURS);
}

export async function refreshTweetPerformance(deps: AppDeps): Promise<{
  accountId: string;
  measured: Array<{ historyId: string; views: number | null; likes: number | null }>;
  failed: string[];
}> {
  const repository = await deps.repository;
  const nowIso = new Date().toISOString();
  const accounts = await repository.listAccounts();
  const history = await repository.listPostHistory();
  const browserModule = await import("@zyquor/browser");

  const measured: Array<{ historyId: string; views: number | null; likes: number | null }> = [];
  const failed: string[] = [];

  const historyTweetIds = new Set<string>();
  for (const item of history) {
    const id = tweetIdFromPostUrl(item.postUrl);
    if (id) historyTweetIds.add(id);
  }

  for (const account of accounts) {
    const candidates = history
      .filter((item) => item.accountId === account.id)
      .filter((item) => needsMeasurement(item, nowIso))
      .sort((left, right) => Date.parse(left.postedAt) - Date.parse(right.postedAt))
      .slice(0, MAX_PER_REFRESH);

    for (const item of candidates) {
      if (!item.postUrl) continue;
      try {
        const result = await browserModule.fetchTweetPerformance({
          profileDir: resolveProfileDir(account.profileDir),
          url: item.postUrl,
          ...browserOptions(deps)
        });
        const performance = {
          views: result.metrics.views,
          likes: result.metrics.likes,
          replies: result.metrics.replies,
          reposts: result.metrics.reposts,
          bookmarks: result.metrics.bookmarks,
          measuredAt: new Date().toISOString()
        };
        await repository.updatePostHistoryMetadata(item.id, withPostPerformance(item.metadata, performance));
        const tweetId = tweetIdFromPostUrl(item.postUrl);
        if (tweetId) {
          await repository.upsertTweetMeasurement({
            accountId: account.id,
            tweetId,
            origin: "zyquor",
            postedAt: item.postedAt,
            text: item.postedText,
            hasLink: /https?:\/\//i.test(item.postedText),
            sourceType: item.sourceType,
            tweetType: item.tweetType,
            views: performance.views,
            likes: performance.likes,
            replies: performance.replies,
            reposts: performance.reposts,
            bookmarks: performance.bookmarks
          });
        }
        measured.push({ historyId: item.id, views: performance.views, likes: performance.likes });
        console.log(
          `[performance] account=${account.id} history=${item.id} views=${performance.views} ` +
            `likes=${performance.likes} replies=${performance.replies} reposts=${performance.reposts} ` +
            `bookmarks=${performance.bookmarks}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push(message);
        console.error(`[performance] failed history=${item.id} account=${account.id}: ${message}`);
      }
    }

    try {
      await measureExternalTweets({ repository, account, historyTweetIds, browserModule, deps, nowIso, measuredThisPass: measured.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push(message);
      console.error(`[performance] external timeline failed account=${account.id}: ${message}`);
    }
  }

  return { accountId: accounts[0]?.id ?? "", measured, failed };
}

async function measureExternalTweets(context: {
  repository: ZyquorRepository;
  account: { id: string; profileDir: string; handle: string };
  historyTweetIds: Set<string>;
  browserModule: typeof import("@zyquor/browser");
  deps: AppDeps;
  nowIso: string;
  measuredThisPass: number;
}): Promise<void> {
  const { repository, account, historyTweetIds, browserModule, deps, nowIso, measuredThisPass } = context;
  // Passive-only capture: ride on a pass that already measured a zyquor post,
  // and even then only about half the time. Never opens the browser on a fixed
  // cadence on its own — a repeated automated profile visit is the exact
  // mechanical pattern bdsm flags (low entropy, serve_to_action=0, no dwell).
  if (measuredThisPass === 0 || Math.random() >= 0.5) return;
  const timeline = await browserModule.fetchAccountTimeline({
    profileDir: resolveProfileDir(account.profileDir),
    handle: account.handle,
    ...browserOptions(deps)
  });
  if (!timeline.tweets.length) return;

  const ledger = await repository.listTweetMeasurements(account.id);
  const recentByTweetId = new Map(ledger.map((item) => [item.tweetId, item.measuredAt]));

  const candidates = timeline.tweets
    .filter((tweet) => tweet.authorHandle === account.handle)
    .filter((tweet) => !tweet.isRetweet)
    .filter((tweet) => {
      const id = tweetIdFromUrl(tweet.url);
      return id !== null && !historyTweetIds.has(id);
    })
    .filter((tweet) => !tweet.publishedAt || tweet.publishedAt <= hoursAgoIso(MIN_AGE_HOURS))
    .filter((tweet) => {
      const id = tweetIdFromUrl(tweet.url);
      const lastMeasured = id ? recentByTweetId.get(id) : undefined;
      return !lastMeasured || lastMeasured < hoursAgoIso(REFETCH_AFTER_HOURS);
    })
    .sort((left, right) => (left.publishedAt ?? "").localeCompare(right.publishedAt ?? ""))
    .slice(0, MAX_PER_REFRESH);

  for (const tweet of candidates) {
    const tweetId = tweetIdFromUrl(tweet.url);
    if (!tweetId) continue;
    try {
      const result = await browserModule.fetchTweetPerformance({
        profileDir: resolveProfileDir(account.profileDir),
        url: tweet.url,
        ...browserOptions(deps)
      });
      await repository.upsertTweetMeasurement({
        accountId: account.id,
        tweetId,
        origin: "external",
        postedAt: tweet.publishedAt,
        text: tweet.text,
        hasLink: tweet.hasLink ?? null,
        sourceType: null,
        tweetType: null,
        views: result.metrics.views,
        likes: result.metrics.likes,
        replies: result.metrics.replies,
        reposts: result.metrics.reposts,
        bookmarks: result.metrics.bookmarks
      });
      console.log(
        `[performance] account=${account.id} external=tweetId:${tweetId} views=${result.metrics.views} ` +
          `likes=${result.metrics.likes} replies=${result.metrics.replies} reposts=${result.metrics.reposts}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[performance] failed external tweetId=${tweetId} account=${account.id}: ${message}`);
    }
  }
}