//! Worker binary. Only starts when `ZYQUOR_RUN_WORKER=1`, mirroring the
//! TypeScript direct-run guard.

use zyquor_worker::{
    WorkerOptions, acquire_worker_lock, default_lock_path, env_interval_ms_or_never, env_poll_ms,
    load_dot_env, start_worker,
};

#[tokio::main(flavor = "current_thread")]
async fn main() {
    load_dot_env();
    if std::env::var("ZYQUOR_RUN_WORKER").ok().as_deref() != Some("1") {
        return;
    }
    let lock_path = default_lock_path();
    let _guard = match acquire_worker_lock(&lock_path) {
        Some(guard) => guard,
        None => return,
    };

    let api_url =
        std::env::var("ZYQUOR_API_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".to_string());
    let auto_seed = std::env::var("ZYQUOR_WORKER_AUTO_SEED_DEFAULT_INGEST")
        .ok()
        .as_deref()
        != Some("0");
    let options = WorkerOptions {
        api_url,
        should_continue: None,
        auto_seed_default_ingest: Some(auto_seed),
        ingest_interval_ms: env_interval_ms_or_never("ZYQUOR_WORKER_INGEST_INTERVAL_MS", 60_000),
        performance_interval_ms: None,
        mentions_interval_ms: None,
        poll_ms: env_poll_ms("ZYQUOR_WORKER_POLL_MS", 5_000),
    };
    let handle = match start_worker(options) {
        Ok(handle) => handle,
        Err(error) => {
            eprintln!("{}", error.message());
            drop(_guard);
            std::process::exit(1);
        }
    };
    let handle = std::sync::Arc::new(handle);
    let signal_handle = handle.clone();
    tokio::spawn(async move {
        #[cfg(unix)]
        {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut terminate) => {
                    tokio::select! {
                        _ = terminate.recv() => signal_handle.request_stop(),
                        _ = tokio::signal::ctrl_c() => signal_handle.request_stop(),
                    }
                }
                Err(_) => {
                    let _ = tokio::signal::ctrl_c().await;
                    signal_handle.request_stop();
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
            signal_handle.request_stop();
        }
    });

    if let Err(error) = handle.wait_finished().await {
        eprintln!("{error}");
        drop(_guard);
        std::process::exit(1);
    }
}
