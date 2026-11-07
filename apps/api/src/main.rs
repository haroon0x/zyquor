//! Server entry: build the app and listen on the API port
//! (`ZYQUOR_API_PORT`, default 3000, fallback 3001 when the port is busy and
//! no explicit port was set) — mirroring `apps/api/src/server.ts`.

use axum::Router;
use zyquor_storage::SqliteRepository;

use zyquor_api::state::{AppState, BuildAppOptions};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// Listen on 127.0.0.1; retry once on 3001 when the primary port is busy and
/// no explicit `ZYQUOR_API_PORT` was set (TS behavior).
async fn listen(app_router: Router) -> Result<(), Box<dyn std::error::Error>> {
    let port = env("ZYQUOR_API_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3000);
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(error)
            if error.kind() == std::io::ErrorKind::AddrInUse
                && env("ZYQUOR_API_PORT").is_none() =>
        {
            eprintln!("Port {port} is busy; retrying on 3001");
            tokio::net::TcpListener::bind(("127.0.0.1", 3001u16)).await?
        }
        Err(error) => return Err(Box::new(error)),
    };
    let bound = listener.local_addr()?.port();
    eprintln!("API listening on http://127.0.0.1:{bound}");
    axum::serve(listener, app_router).await?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let enable_browser_prepare = env("ZYQUOR_ENABLE_BROWSER_PREPARE").as_deref() == Some("1");
    let enable_browser_post = env("ZYQUOR_ENABLE_BROWSER_POST").as_deref() == Some("1");
    let browser_channel = env("ZYQUOR_BROWSER_CHANNEL");
    let browser_cdp_url = env("ZYQUOR_BROWSER_CDP_URL");
    let browser_action_delay_ms =
        env("ZYQUOR_BROWSER_ACTION_DELAY_MS").and_then(|value| value.parse::<u64>().ok());
    let browser_typing_delay_ms =
        env("ZYQUOR_BROWSER_TYPING_DELAY_MS").and_then(|value| value.parse::<u64>().ok());
    let close_after_prepare = env("ZYQUOR_BROWSER_CLOSE_AFTER_PREPARE").as_deref() != Some("0");
    let close_after_post = env("ZYQUOR_BROWSER_CLOSE_AFTER_POST").as_deref() != Some("0");

    let db_path = zyquor_core::paths::data_path(["app.sqlite"]);
    let repository = SqliteRepository::open(&db_path)?;
    let options = BuildAppOptions {
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
        ..BuildAppOptions::default()
    };
    let state = AppState::new(repository, db_path, &options).map_err(std::io::Error::other)?;
    let app_router: Router = zyquor_api::build_app(state);
    listen(app_router).await
}
