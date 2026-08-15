import { postPerformanceFromMetadata, withPostPerformance, type PostHistory } from "@zyquor/core";
import type { ZyquorRepository } from "@zyquor/storage";
import type { AppDeps } from "../deps.js";
import { browserOptions } from "./browser.js";
import { resolveProfileDir } from "./paths.js";

const MIN_AGE_HOURS = Number(process.env.ZYQUOR_PERFORMANCE_MIN_AGE_HOURS ?? 2);
const REFETCH_AFTER_HOURS = Number(process.env.ZYQUOR_PERFORMANCE_REFETCH_HOURS ?? 12);
const MAX_PER_REFRESH = Number(process.env.ZYQUOR_PERFORMANCE_MAX_PER_REFRESH ?? 3);

function hoursAgoIso(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function tweetIdFromPostUrl(postUrl: string | null): string | null {
  if (!postUrl) return null;
  const match = /\/status\/(\d+)\/?$/.exec(postUrl);
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
  }

  return { accountId: accounts[0]?.id ?? "", measured, failed };
}
