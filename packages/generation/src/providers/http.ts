import type { FetchLike } from "../types.js";

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 70_000;
const NEAR_RESET_THRESHOLD_MS = 90_000;

export function backoffMs(attempt: number, retryAfter: string | null, rateLimitReset: string | null, now = Date.now()) {
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);

  const resetValue = Number(rateLimitReset);
  const resetAt = Number.isFinite(resetValue) && resetValue > 0 && resetValue < 1_000_000_000_000
    ? resetValue * 1000
    : resetValue;
  if (Number.isFinite(resetAt) && resetAt > now) {
    const waitMs = resetAt - now;
    if (waitMs <= NEAR_RESET_THRESHOLD_MS) return waitMs + 500;
    return MAX_BACKOFF_MS;
  }

  return Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

export async function postJson<T>(
  fetchImpl: FetchLike,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
) {
  let lastDetail = "";
  let lastStatus = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers
      },
      body: JSON.stringify(body)
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    lastStatus = response.status;
    lastDetail = await response.text().catch(() => "");

    if (!RETRY_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
      break;
    }

    await sleep(
      backoffMs(
        attempt,
        response.headers?.get?.("retry-after") ?? null,
        response.headers?.get?.("x-ratelimit-reset") ?? null
      )
    );
  }

  throw new Error(`Generation request failed: ${lastStatus}${lastDetail ? ` ${lastDetail}` : ""}`);
}

export async function getJson<T>(fetchImpl: FetchLike, url: string, headers: Record<string, string> = {}) {
  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Generation metadata request failed: ${response.status}${detail ? ` ${detail}` : ""}`);
  }

  return (await response.json()) as T;
}
