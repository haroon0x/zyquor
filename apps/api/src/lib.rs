//! Rust port of `apps/api` — the HTTP API server (axum).
//!
//! The TypeScript tree runs the same routes until each port passes a parity
//! check (recorded route fixtures). Response shapes match the TypeScript tree
//! exactly (camelCase JSON via the storage model serialization).
//!
//! Deep modules:
//! - `errors` owns the HTTP error surface (400 with zod-style issues, 404,
//!   409, 503 for generation failures, 500 fallback) — the Fastify
//!   `setErrorHandler` equivalent.
//! - `state` owns `AppState` + the async [`state::Repository`] proxy over
//!   the synchronous rusqlite storage; handler DB access `spawn_blocking`s
//!   per call, never blocking the executor.
//! - Route modules own their handlers; one public `route` fn each.
//! - `deps` builds the app-level dependencies (generation env merging,
//!   provider factory) and the browser config struct.

pub mod deps;
pub mod errors;
#[path = "lib/history.rs"]
pub mod history;
pub mod lib_deps;
#[path = "lib/media.rs"]
pub mod media;
#[path = "lib/post_history_snapshot.rs"]
pub mod post_history_snapshot;
#[path = "lib/post_process.rs"]
pub mod post_process;
pub mod state;
#[path = "lib/tweet_performance.rs"]
pub mod tweet_performance;

pub mod routes;

pub use state::{
    AppState, BuildAppOptions, DesktopControlPlane, Repository, RuntimeState, WorkerHeartbeat,
};

use axum::Router;

/// Build the axum router (the state is carried as a `State` extension).
pub fn build_app(state: AppState) -> Router {
    Router::new()
        .merge(routes::accounts::router())
        .merge(routes::batches::router())
        .merge(routes::browser::router())
        .merge(routes::drafts::router())
        .merge(routes::generation::router())
        .merge(routes::history::router())
        .merge(routes::ingest::router())
        .merge(routes::jobs::router())
        .merge(routes::knowledge::router())
        .merge(routes::onboarding::router())
        .merge(routes::performance::router())
        .merge(routes::replies::router())
        .merge(routes::settings::router())
        .merge(routes::source_packets::router())
        .merge(routes::style_profiles::router())
        .merge(routes::system::router())
        .merge(routes::system_feedback::router())
        .merge(routes::worker::router())
        .layer(tower_http::cors::CorsLayer::permissive())
        .with_state(state)
}
