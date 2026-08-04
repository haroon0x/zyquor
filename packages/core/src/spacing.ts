const MS_PER_MINUTE = 60_000;

export interface NextAutopostInput {
  lastScheduledFor: string | null;
  timestamp: string;
  gapMinMinutes: number;
  gapMaxMinutes: number;
  jitterRatio?: number;
  recentGapMs?: number[];
  traceId?: string;
}

export interface NextAutopostResult {
  scheduledFor: string;
  gapMs: number;
  gapMinutes: number;
  reason: string;
}

function applyAntiCluster(recentGapMs: number[] | undefined): { apply: boolean; range: [number, number] } {
  if (!recentGapMs || recentGapMs.length < 3) {
    return { apply: false, range: [0, 0] };
  }
  const tail = recentGapMs.slice(-3);
  const max = Math.max(...tail);
  const min = Math.min(...tail);
  const mean = tail.reduce((sum, value) => sum + value, 0) / tail.length;
  const spread = max - min;
  const variance = mean > 0 ? spread / mean : 0;
  if (variance >= 0.4) {
    return { apply: false, range: [0, 0] };
  }
  return {
    apply: true,
    range: [45 * MS_PER_MINUTE, 90 * MS_PER_MINUTE]
  };
}

function pickRandomGap(
  minMs: number,
  maxMs: number,
  lastGapMs: number | null,
  antiClusterRange: [number, number] | null
): { gapMs: number; reason: string } {
  const low = antiClusterRange ? antiClusterRange[0] : minMs;
  const high = antiClusterRange ? antiClusterRange[1] : maxMs;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = low + Math.random() * (high - low);
    if (!lastGapMs || lastGapMs <= 0) {
      return { gapMs: Math.round(candidate), reason: "fresh" };
    }
    const ratio = candidate / lastGapMs;
    if (ratio >= 0.7 && ratio <= 1.4) {
      continue;
    }
    return { gapMs: Math.round(candidate), reason: "diverse-from-last" };
  }
  return { gapMs: Math.round((low + high) / 2), reason: "fallback-mid" };
}

export interface PostGateInput {
  gapMinMinutes: number;
  lastPostedAt: string | null;
  now: string;
  traceId?: string;
}

export interface PostGateResult {
  allowed: boolean;
  nextEligibleAt: string | null;
  reason: string;
  requiredGapMinutes: number;
  waitMinutes: number;
}

export function evaluatePostGate(input: PostGateInput): PostGateResult {
  const nowMs = Date.parse(input.now);

  if (!input.lastPostedAt) {
    return { allowed: true, nextEligibleAt: null, reason: "no-previous-post", requiredGapMinutes: 0, waitMinutes: 0 };
  }

  const lastMs = Date.parse(input.lastPostedAt);
  if (!Number.isFinite(lastMs)) {
    return { allowed: true, nextEligibleAt: null, reason: "unparsable-last-post", requiredGapMinutes: 0, waitMinutes: 0 };
  }

  const gapMinutes = Number.isFinite(input.gapMinMinutes) ? Math.max(5, input.gapMinMinutes) : 30;
  const requiredGapMs = gapMinutes * MS_PER_MINUTE;
  const reason = "minimum-gap";

  const nextEligibleMs = lastMs + requiredGapMs;
  const allowed = nowMs >= nextEligibleMs;
  const waitMs = Math.max(0, nextEligibleMs - nowMs);

  console.log(
    `${input.traceId ? `[trace=${input.traceId}] ` : ""}[post-gate] ` +
      `lastPostedAt=${input.lastPostedAt} requiredGap=${Math.round(requiredGapMs / MS_PER_MINUTE)}m ` +
      `nextEligibleAt=${new Date(nextEligibleMs).toISOString()} allowed=${allowed} ` +
      `wait=${Math.round(waitMs / MS_PER_MINUTE)}m reason=${reason}`
  );

  return {
    allowed,
    nextEligibleAt: new Date(nextEligibleMs).toISOString(),
    reason,
    requiredGapMinutes: Math.round((requiredGapMs / MS_PER_MINUTE) * 10) / 10,
    waitMinutes: Math.round((waitMs / MS_PER_MINUTE) * 10) / 10
  };
}

export function nextAutopostScheduledFor(input: NextAutopostInput): NextAutopostResult {
  const tracePrefix = input.traceId ? `[trace=${input.traceId}] ` : "";
  const nowMs = Date.parse(input.timestamp);
  const gapMinMinutes = Number.isFinite(input.gapMinMinutes) ? Math.max(5, input.gapMinMinutes) : 30;
  const gapMaxMinutes = Number.isFinite(input.gapMaxMinutes)
    ? Math.max(gapMinMinutes + 5, input.gapMaxMinutes)
    : Math.max(gapMinMinutes + 5, 90);
  const minMs = gapMinMinutes * MS_PER_MINUTE;
  const maxMs = gapMaxMinutes * MS_PER_MINUTE;
  const lastMs = input.lastScheduledFor ? Date.parse(input.lastScheduledFor) : nowMs;
  const anchor = Math.max(lastMs, nowMs);

  const lastGapMs = input.recentGapMs && input.recentGapMs.length > 0
    ? (input.recentGapMs[input.recentGapMs.length - 1] ?? null)
    : null;

  const boost = applyAntiCluster(input.recentGapMs);
  const picked = pickRandomGap(minMs, maxMs, lastGapMs, boost.apply ? boost.range : null);

  let gapMs = picked.gapMs;
  if (gapMs < minMs) {
    gapMs = minMs;
  }
  if (gapMs > maxMs * 1.2) {
    gapMs = maxMs * 1.2;
  }

  const scheduledFor = new Date(anchor + gapMs).toISOString();
  const gapMinutes = Math.round((gapMs / MS_PER_MINUTE) * 10) / 10;
  const reason = boost.apply ? `anti-cluster: ${picked.reason}` : picked.reason;

  console.log(
    `${tracePrefix}[spacing] next-schedule: ` +
      `timestamp=${input.timestamp} lastScheduledFor=${input.lastScheduledFor ?? "null"} ` +
      `gapMin=${input.gapMinMinutes} gapMax=${input.gapMaxMinutes} ` +
      `pickedGapMs=${picked.gapMs} finalGapMs=${gapMs} (${gapMinutes} min) ` +
      `reason=${reason} antiCluster=${boost.apply} ` +
      `recentGaps=[${(input.recentGapMs ?? []).map((g) => `${Math.round(g / MS_PER_MINUTE)}m`).join(",")}] ` +
      `scheduledFor=${scheduledFor}`
  );

  return {
    scheduledFor,
    gapMs,
    gapMinutes,
    reason
  };
}
