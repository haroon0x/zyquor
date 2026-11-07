//! Post-history TTL purge, ported from `apps/api/src/lib/history.ts`.

const POST_HISTORY_TTL_MS: i64 = 24 * 60 * 60 * 1000;

/// `purgeExpiredPostHistory(repository)` — purge rows older than 24 hours.
pub async fn purge_expired_post_history(
    repository: &crate::state::Repository,
) -> Result<usize, zyquor_storage::StorageError> {
    let cutoff_millis = chrono::Utc::now().timestamp_millis() - POST_HISTORY_TTL_MS;
    let cutoff = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(cutoff_millis)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
    repository.purge_post_history_older_than(&cutoff).await
}
