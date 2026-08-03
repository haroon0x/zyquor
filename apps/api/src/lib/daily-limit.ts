import type { ZyquorRepository } from "@zyquor/storage";

const ABSOLUTE_DAILY_POST_LIMIT = 4;

function dailyHash(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function dailyVarianceCap(): { min: number; max: number; value: number; traceId: string; absolute: number } {
  const min = Math.min(ABSOLUTE_DAILY_POST_LIMIT, Math.max(1, Number(process.env.ZYQUOR_DAILY_POST_VARIANCE_MIN ?? 3)));
  const requestedMax = Math.max(min, Number(process.env.ZYQUOR_DAILY_POST_VARIANCE_MAX ?? 4));
  const max = Math.min(requestedMax, ABSOLUTE_DAILY_POST_LIMIT);
  const seed = new Date().toISOString().slice(0, 10);
  const span = max - min + 1;
  const value = min + (dailyHash(seed) % span);
  return { min, max, value, traceId: seed, absolute: ABSOLUTE_DAILY_POST_LIMIT };
}

export async function isDailyLimitReached(repository: ZyquorRepository, accountId: string, dailyPostLimit: number | null) {
  const variance = dailyVarianceCap();
  const effectiveLimit = Math.min(dailyPostLimit ?? Number.POSITIVE_INFINITY, variance.value);
  const traceId = variance.traceId;

  const today = new Date().toISOString().slice(0, 10);
  const history = await repository.listPostHistory();
  const postsToday = history.filter((item) => item.accountId === accountId && item.postedAt.startsWith(today)).length;
  const reached = postsToday >= effectiveLimit;
  console.log(
    `[trace=${traceId}] [daily-limit] account=${accountId} accountDailyPostLimit=${dailyPostLimit} ` +
      `varianceCap=${variance.value} (min=${variance.min} max=${variance.max}) absoluteCeiling=${variance.absolute} ` +
      `postsToday=${postsToday} effectiveLimit=${effectiveLimit} reached=${reached}`
  );
  return reached;
}
