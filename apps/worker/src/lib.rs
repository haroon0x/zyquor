//! Background polling worker for Zyquor.
//!
//! Rust port of `apps/worker/src/index.ts`. The worker is a pure HTTP client
//! against the API base URL (`ZYQUOR_API_URL`, default
//! `http://127.0.0.1:3000`): it recovers stale ingest runs and jobs, drives
//! approved post jobs (quiet hours, spacing backfill, post gates), polls
//! pending drafts and source packets, kicks the async ingest run on an
//! interval, refreshes performance, scans mentions, and heartbeats.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod client;
pub mod env;
pub mod lock;
pub mod types;
pub mod worker;

pub use client::{ApiClient, ApiError, percent_encode};
pub use env::{
    env_f64, env_flag, env_interval_ms_or_never, env_poll_ms, env_spacing_f64, env_var,
    load_dot_env,
};
pub use lock::{WorkerLockGuard, acquire_worker_lock, default_lock_path, pid_is_alive};
pub use types::{
    Account, AccountsResponse, ConfigsResponse, DraftSummary, DraftsResponse, HealthResponse,
    HeartbeatBody, IngestConfigSummary, IngestRunResponse, JobsResponse, MentionApproveResult,
    MentionDraftResult, PacketsResponse, PerformanceResponse, PostJob, RecoverStaleResponse,
    SeedResponse, SeededConfig, SourcePacket, XSession,
};
pub use worker::{
    CycleReport, ShouldContinue, StartupReport, WorkerDescription, WorkerHandle, WorkerOptions,
    WorkerState, check_worker_startup, create_worker_state, describe_worker, heartbeat,
    mentions_accounts_from_env, mentions_auto_approve_enabled, mentions_auto_draft_enabled,
    post_enabled, process_approved_jobs, process_ingest, process_mentions_auto_approve,
    process_mentions_auto_draft, process_new_source_packets, process_pending_drafts,
    recover_stale_jobs, refresh_performance, run_worker, run_worker_cycle, start_worker,
};
