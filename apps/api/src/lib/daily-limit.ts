import type { ZyquorRepository } from "@zyquor/storage";

// Hard stop set by the operator through the environment; the conservative
// default only applies when ZYQUOR_DAILY_POST_CEILING is unset.
function absoluteDailyPostLimit() {
  return envInteger("ZYQUOR_DAILY_POST_CEILING", 4);
}

function dailyHash(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function envInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function dailyVarianceCap(): { min: number; max: number; value: number; traceId: string; absolute: number } {
  const absolute = absoluteDailyPostLimit();
  const min = Math.min(absolute, Math.max(1, envInteger("ZYQUOR_DAILY_POST_VARIANCE_MIN", 2)));
  const requestedMax = Math.max(min, envInteger("ZYQUOR_DAILY_POST_VARIANCE_MAX", 4));
  const max = Math.min(requestedMax, absolute);
  const seed = new Date().toISOString().slice(0, 10);
  const span = max - min + 1;
  const value = min + (dailyHash(seed) % span);
  return { min, max, value, traceId: seed, absolute };
}

export async function isDailyLimitReached(repository: ZyquorRepository, accountId: string, dailyPostLimit: number | null) {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyPostLimit == null || dailyPostLimit <= 0) {
    console.log(
      `[trace=${today}] [daily-limit] account=${accountId} accountDailyPostLimit=${dailyPostLimit} ` +
        `reached=false (no limit configured)`
    );
    return false;
  }
  const variance = dailyVarianceCap();
  const effectiveLimit = Math.min(dailyPostLimit, variance.value);
  const traceId = variance.traceId;

  // Indexed count over post_history(account_id, posted_at) instead of loading
  // and scanning every history row (postedAt is Z-format ISO, so the day string
  // maps exactly to counting rows >= midnight UTC of today).
  const sinceIso = `${today}T00:00:00.000Z`;
  const postsToday = await repository.countPostHistorySince(accountId, sinceIso);
  const reached = postsToday >= effectiveLimit;  console.log(
    `[trace=${traceId}] [daily-limit] account=${accountId} accountDailyPostLimit=${dailyPostLimit} ` +
      `varianceCap=${variance.value} (min=${variance.min} max=${variance.max}) absoluteCeiling=${variance.absolute} ` +
      `postsToday=${postsToday} effectiveLimit=${effectiveLimit} reached=${reached}`
  );
  return reached;
}
