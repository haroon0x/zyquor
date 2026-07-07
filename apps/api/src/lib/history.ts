const POST_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

export async function purgeExpiredPostHistory(repository: { purgePostHistoryOlderThan: (iso: string) => Promise<unknown> }) {
  return repository.purgePostHistoryOlderThan(new Date(Date.now() - POST_HISTORY_TTL_MS).toISOString());
}
