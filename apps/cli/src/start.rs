//! `zyquor start|api|worker|web` — dev runner.
//!
//! Port of `scripts/zyquor.mjs`: `start` brings up the API (in-process via
//! `zyquor_api::build_app` + axum), the worker (`zyquor_worker::start_worker`)
//! and the web dev server; `api`/`worker`/`web` run one piece. Env defaults
//! mirror the TS script (`ZYQUOR_API_PORT_OVERRIDE` else 3001,
//! `ZYQUOR_API_URL_OVERRIDE`, `ZYQUOR_BROWSER_CDP_URL`,
//! `ZYQUOR_X_PROFILE_DIR`).

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use zyquor_storage::SqliteRepository;

use crate::cli;

fn api_port() -> u16 {
    std::env::var("ZYQUOR_API_PORT_OVERRIDE")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3001)
}

fn build_state() -> Result<zyquor_api::AppState, String> {
    let enable_browser_prepare = cli::env_flag("ZYQUOR_ENABLE_BROWSER_PREPARE");
    let enable_browser_post = cli::env_flag("ZYQUOR_ENABLE_BROWSER_POST");
    let browser_channel = std::env::var("ZYQUOR_BROWSER_CHANNEL").ok();
    let browser_cdp_url = std::env::var("ZYQUOR_BROWSER_CDP_URL").ok();
    let browser_action_delay_ms = std::env::var("ZYQUOR_BROWSER_ACTION_DELAY_MS")
        .ok()
        .and_then(|v| v.parse().ok());
    let browser_typing_delay_ms = std::env::var("ZYQUOR_BROWSER_TYPING_DELAY_MS")
        .ok()
        .and_then(|v| v.parse().ok());
    let close_after_prepare =
        std::env::var("ZYQUOR_BROWSER_CLOSE_AFTER_PREPARE").as_deref() != Ok("0");
    let close_after_post = std::env::var("ZYQUOR_BROWSER_CLOSE_AFTER_POST").as_deref() != Ok("0");

    let db_path = zyquor_core::paths::data_path(["app.sqlite"]);
    let repository = SqliteRepository::open(&db_path).map_err(|error| error.to_string())?;
    let options = zyquor_api::BuildAppOptions {
        enable_browser_prepare,
        enable_browser_post,
        browser_action_delay_ms,
        browser_channel: browser_channel.as_deref().and_then(|channel| {
            if channel == "chromium" {
                None
            } else {
                Some(channel.to_string())
            }
        }),
        browser_cdp_url,
        browser_typing_delay_ms,
        close_after_prepare: Some(close_after_prepare),
        close_after_post: Some(close_after_post),
        ..zyquor_api::BuildAppOptions::default()
    };
    zyquor_api::AppState::new(repository, db_path, &options).map_err(|error| error.to_string())
}

pub async fn run_api() -> Result<i32, String> {
    cli::http(&cli::api_url_for_zyquor());
    let port = api_port();
    let state = build_state()?;
    let router = zyquor_api::build_app(state);
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(error) => return Err(format!("cannot bind API port {port}: {error}")),
    };
    let bound = listener
        .local_addr()
        .map(|addr| addr.port())
        .unwrap_or(port);
    eprintln!("API listening on http://127.0.0.1:{bound}");
    axum::serve(listener, router)
        .await
        .map_err(|error| error.to_string())?;
    Ok(0)
}

pub async fn run_worker() -> Result<i32, String> {
    if std::env::var("ZYQUOR_RUN_WORKER").ok().as_deref() != Some("1") {
        eprintln!("worker not started: set ZYQUOR_RUN_WORKER=1 (mirrors the worker guard)");
        return Ok(0);
    }
    run_worker_unchecked().await
}

async fn run_worker_unchecked() -> Result<i32, String> {
    let lock_path = zyquor_worker::default_lock_path();
    let Some(_guard) = zyquor_worker::acquire_worker_lock(&lock_path) else {
        eprintln!(
            "worker already running (lock {} held); exiting",
            lock_path.display()
        );
        return Ok(0);
    };
    let api_url =
        std::env::var("ZYQUOR_API_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".to_string());
    let auto_seed = std::env::var("ZYQUOR_WORKER_AUTO_SEED_DEFAULT_INGEST")
        .ok()
        .as_deref()
        != Some("0");
    let options = zyquor_worker::WorkerOptions {
        api_url,
        should_continue: None,
        auto_seed_default_ingest: Some(auto_seed),
        ingest_interval_ms: zyquor_worker::env_interval_ms_or_never(
            "ZYQUOR_WORKER_INGEST_INTERVAL_MS",
            60_000,
        ),
        performance_interval_ms: None,
        mentions_interval_ms: None,
        poll_ms: zyquor_worker::env_poll_ms("ZYQUOR_WORKER_POLL_MS", 5_000),
    };
    let handle =
        zyquor_worker::start_worker(options).map_err(|error| error.message().to_string())?;
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

    match handle.wait_finished().await {
        Ok(()) => Ok(0),
        Err(error) => {
            eprintln!("{error}");
            Ok(1)
        }
    }
}

pub async fn run_web() -> Result<i32, String> {
    let web_dir = cli::repo_root().join("apps").join("web");
    if !web_dir.is_dir() {
        println!(
            "Web UI not present at {web_dir}",
            web_dir = web_dir.display()
        );
        return Ok(0);
    }
    let api_url = cli::api_url_for_zyquor();
    let mut child = match Command::new("pnpm")
        .args(["run", "dev"])
        .current_dir(&web_dir)
        .env("ZYQUOR_API_URL", &api_url)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            eprintln!("Could not start web dev server with pnpm: {error}");
            eprintln!("Start it manually from {}", web_dir.display());
            return Ok(1);
        }
    };
    wait_child(&mut child).await
}

async fn wait_child(child: &mut Child) -> Result<i32, String> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.code().unwrap_or(1)),
            Ok(None) => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn profile_dir() -> PathBuf {
    let value = cli::env_or("ZYQUOR_X_PROFILE_DIR", "profiles/personal-main");
    let path = PathBuf::from(&value);
    if path.is_absolute() {
        path
    } else {
        cli::repo_root().join(path)
    }
}

fn web_dir() -> PathBuf {
    cli::repo_root().join("apps").join("web")
}

fn web_present() -> bool {
    web_dir().is_dir()
}

async fn fetch_status(
    client: &reqwest::Client,
    api_url: &str,
    path: &str,
) -> Option<serde_json::Value> {
    let response = client.get(format!("{api_url}{path}")).send().await.ok()?;
    let text = response.text().await.ok()?;
    serde_json::from_str(&text).ok()
}

async fn print_status(api_url: &str, cdp_url: &str, dir: &std::path::Path, web_url: &str) {
    let client = reqwest::Client::new();
    let health = fetch_status(&client, api_url, "/health")
        .await
        .unwrap_or(serde_json::json!({"error": "api unreachable"}));
    let session = fetch_status(
        &client,
        api_url,
        "/browser/x-session?accountId=account_personal",
    )
    .await
    .unwrap_or(serde_json::json!({"loggedIn": false}));
    let logged_in = session
        .get("loggedIn")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let provider = health
        .get("generation")
        .and_then(|g| g.get("provider"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let model = health
        .get("generation")
        .and_then(|g| g.get("model"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    println!();
    println!("Zyquor running");
    println!("Web: {web_url}");
    println!("API: {api_url}");
    println!("Chrome CDP: {cdp_url}");
    println!("Profile: {}", dir.display());
    println!(
        "X: {}",
        if logged_in {
            "logged in"
        } else {
            "not logged in"
        }
    );
    if !logged_in {
        println!("Posting paused by worker until X login returns.");
        println!("Login command: zyquor open-profile --manual");
    }
    println!("Generation: {provider} {model}");
    println!();
    println!("Use web UI for normal work. Keep this terminal open.");
    println!("Post from the UI, or explicitly: POST /jobs/:id/post");
    println!();
}

pub async fn run_start() -> Result<i32, String> {
    let port = api_port();
    let api_url = cli::api_url_for_zyquor();
    let cdp_url = cli::cdp_url();
    let dir = profile_dir();
    let web_url = "http://127.0.0.1:5173/";

    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let cdp_up = zyquor_browser::ensure_browser_cdp(&cdp_url, &dir.to_string_lossy()).await;
    if !cdp_up {
        eprintln!("Chrome CDP did not become ready: {cdp_url}");
        return Ok(1);
    }

    let api_probe = cli::http(&api_url);
    let _ = api_probe;
    let api_already_running = is_ok_url(&format!("{api_url}/health")).await;

    let serve_handle: Option<tokio::task::JoinHandle<()>> = if api_already_running {
        None
    } else {
        let state = build_state()?;
        let router = zyquor_api::build_app(state);
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => listener,
            Err(error) => return Err(format!("cannot bind API port {port}: {error}")),
        };
        eprintln!("API listening on http://127.0.0.1:{port}");
        Some(tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        }))
    };

    // Wait for the API to answer (api already running, or up to 60s).
    let api_ready = if api_already_running {
        true
    } else {
        wait_for_url(&format!("{api_url}/health"), 60_000).await
    };
    if !api_ready {
        eprintln!("API did not become ready: {api_url}");
        if let Some(handle) = serve_handle {
            handle.abort();
        }
        return Ok(1);
    }

    let web_already_running = is_ok_url(web_url).await;
    let mut web_child: Option<Child> = None;
    if !web_already_running {
        if web_present() {
            let web_root = cli::repo_root().join("apps").join("web");
            match Command::new("pnpm")
                .args(["run", "dev"])
                .current_dir(&web_root)
                .env("ZYQUOR_API_URL", &api_url)
                .stdin(Stdio::null())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit())
                .spawn()
            {
                Ok(child) => {
                    web_child = Some(child);
                    wait_for_url(web_url, 90_000).await;
                }
                Err(error) => {
                    eprintln!("Could not start web dev server: {error}");
                    println!("Web UI at {}", web_dir().display());
                }
            }
        } else {
            println!(
                "Web UI not present at {}; start the web app manually.",
                web_dir().display()
            );
        }
    }

    // Worker in-process (guarded like `zyquor worker`).
    let api_url_worker = api_url.clone();
    let worker_handle: Option<tokio::task::JoinHandle<i32>> =
        if std::env::var("ZYQUOR_RUN_WORKER").ok().as_deref() == Some("1") {
            Some(tokio::spawn(async move {
                let _ = cli::http(&api_url_worker);
                let _ = api_url_for_worker();
                run_worker_unchecked().await.unwrap_or(0)
            }))
        } else {
            // Start the worker task with the env flag set for this process only
            // via direct options: start_worker without re-checking the guard.
            Some(tokio::spawn(async move {
                let lock_path = zyquor_worker::default_lock_path();
                let Some(_guard) = zyquor_worker::acquire_worker_lock(&lock_path) else {
                    return 0;
                };
                let api = std::env::var("ZYQUOR_API_URL")
                    .unwrap_or_else(|_| "http://127.0.0.1:3000".to_string());
                let auto_seed = std::env::var("ZYQUOR_WORKER_AUTO_SEED_DEFAULT_INGEST")
                    .ok()
                    .as_deref()
                    != Some("0");
                let options = zyquor_worker::WorkerOptions {
                    api_url: api,
                    should_continue: None,
                    auto_seed_default_ingest: Some(auto_seed),
                    ingest_interval_ms: zyquor_worker::env_interval_ms_or_never(
                        "ZYQUOR_WORKER_INGEST_INTERVAL_MS",
                        60_000,
                    ),
                    performance_interval_ms: None,
                    mentions_interval_ms: None,
                    poll_ms: zyquor_worker::env_poll_ms("ZYQUOR_WORKER_POLL_MS", 5_000),
                };
                match zyquor_worker::start_worker(options) {
                    Ok(handle) => {
                        let handle = std::sync::Arc::new(handle);
                        let _ = handle.wait_finished().await;
                        0
                    }
                    Err(_) => 1,
                }
            }))
        };

    print_status(&api_url, &cdp_url, &dir, web_url).await;

    // Run until interrupted; keeps TS retry semantics by blocking here.
    let _ = tokio::signal::ctrl_c().await;
    println!("\nStopping zyquor…");
    if let Some(child) = &mut web_child {
        let _ = child.kill();
    }
    if let Some(handle) = serve_handle {
        handle.abort();
    }
    if let Some(handle) = worker_handle {
        handle.abort();
    }
    Ok(0)
}

fn api_url_for_worker() -> String {
    std::env::var("ZYQUOR_API_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".to_string())
}

async fn is_ok_url(url: &str) -> bool {
    // Probe via full URL: request the given absolute URL.
    reqwest::Client::new()
        .get(url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map(|response| response.status().is_success())
        .unwrap_or(false)
}

async fn wait_for_url(url: &str, timeout_ms: u64) -> bool {
    let started = std::time::Instant::now();
    while started.elapsed().as_millis() < timeout_ms as u128 {
        if is_ok_url(url).await {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    false
}
