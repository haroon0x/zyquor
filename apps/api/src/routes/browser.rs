//! Browser routes, ported from `apps/api/src/routes/browser.ts`.

use axum::{
    Json, Router,
    extract::{Query, State},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::errors::ApiError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/browser/activate", post(activate))
        .route("/browser/active", get(active))
        .route("/browser/x-session", get(x_session))
        .route("/browser/launch-chrome", post(launch_chrome))
}

fn resolve_profile_dir(profile_dir: &str) -> String {
    if std::path::Path::new(profile_dir).is_absolute() {
        profile_dir.to_string()
    } else {
        zyquor_core::paths::resolve_data_root()
            .join(profile_dir)
            .to_string_lossy()
            .to_string()
    }
}

fn per_profile_cdp_url(base: Option<&str>, profile_dir: &str) -> String {
    zyquor_core::paths::per_profile_cdp_url(base, profile_dir)
}

fn profile_tail(profile_dir: &str) -> String {
    let normalized = profile_dir.replace('\\', "/");
    let marker = "/profiles/";
    if let Some(index) = normalized.rfind(marker) {
        normalized[index + marker.len()..].to_string()
    } else {
        normalized
    }
}

fn browser_cdp_base(state: &AppState) -> Option<String> {
    match state.browser.lock() {
        Ok(guard) => guard.cdp_url.clone(),
        Err(poisoned) => poisoned.into_inner().cdp_url.clone(),
    }
}

fn browser_enable_prepare(state: &AppState) -> bool {
    match state.browser.lock() {
        Ok(guard) => guard.enable_prepare,
        Err(poisoned) => poisoned.into_inner().enable_prepare,
    }
}

async fn check_x_login(cdp_url: &str) -> Result<zyquor_browser::CheckXLoginResult, String> {
    let session = zyquor_browser::Session::connect(cdp_url).await?;
    zyquor_browser::check_x_login(&session, "https://x.com/home").await
}

async fn active_account_id_from_launch_state(
    state: &AppState,
    accounts: &[zyquor_accounts::Account],
) -> String {
    let _ = state;
    let launch_state = zyquor_browser::launch_state::read_cdp_launch_state();
    let Some(launch_state) = launch_state else {
        return "account_personal".to_string();
    };
    let active = accounts
        .iter()
        .find(|item| resolve_profile_dir(&item.profile_dir) == launch_state.profile_dir);
    active
        .map(|account| account.id.clone())
        .unwrap_or_else(|| "account_personal".to_string())
}

#[derive(Deserialize, Default)]
struct ActivateBody {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

async fn activate(
    State(state): State<AppState>,
    Json(body): Json<ActivateBody>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let accounts = repository.list_accounts().await?;
    let account = body
        .account_id
        .as_ref()
        .and_then(|id| accounts.iter().find(|item| item.id == *id));
    let Some(account) = account else {
        return Err(ApiError::http(404, "Account not found"));
    };
    let account = account.clone();
    if let Err(error) = zyquor_accounts::assert_dedicated_profile_dir(&account.profile_dir) {
        return Err(ApiError::Internal(error.to_string()));
    }
    let profile_dir = resolve_profile_dir(&account.profile_dir);
    let base = browser_cdp_base(&state);
    let cdp_url = per_profile_cdp_url(base.as_deref(), &account.profile_dir);

    {
        let mut guard = match state.runtime.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.browser_loaded = true;
    }

    // Rust has no launchPostingChrome injection: use the browser crate directly.
    let launched = zyquor_browser::ensure_browser_cdp(&cdp_url, &profile_dir).await;
    if !launched {
        return Err(ApiError::http(
            409,
            format!(
                "Could not launch Chrome for @{}: {cdp_url} unavailable",
                account.handle
            ),
        ));
    }

    let session = match check_x_login(&cdp_url).await {
        Ok(result) => result,
        Err(_) => zyquor_browser::CheckXLoginResult {
            logged_in: false,
            url: String::new(),
            handle: None,
        },
    };

    let expected_handle = account.handle.trim_start_matches('@').to_lowercase();
    let mut response = json!({
        "accountId": account.id,
        "handle": account.handle,
        "active": true,
        "loggedIn": session.logged_in,
        "observedHandle": session.handle,
    });
    if let Some(ref handle) = session.handle {
        if handle != &expected_handle {
            response["warning"] = json!(format!(
                "Posting Chrome is logged in as @{handle}, not @{expected_handle}. Posting will be refused until the right login is active."
            ));
        }
    }
    Ok(Json(response))
}

#[derive(Deserialize)]
struct XSessionQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

async fn active(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let accounts = repository.list_accounts().await?;

    {
        let mut guard = match state.runtime.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.browser_loaded = true;
    }

    let states = zyquor_browser::launch_state::read_all_cdp_launch_states(
        &zyquor_browser::launch_state::cdp_launch_state_file(),
    );
    if states.is_empty() {
        return Ok(Json(
            json!({"accountId": Value::Null, "handle": Value::Null, "profileDir": Value::Null, "cdpUrl": Value::Null, "activeAccounts": []}),
        ));
    }

    let base = browser_cdp_base(&state);
    let mut active_accounts = Vec::new();
    for launch_state in &states {
        let resolved = accounts.iter().find(|item| {
            profile_tail(&resolve_profile_dir(&item.profile_dir))
                == profile_tail(&launch_state.profile_dir)
        });
        let account_id = resolved.map(|account| account.id.clone());
        let handle = resolved.map(|account| account.handle.clone());
        let cdp_url = launch_state
            .cdp_url
            .clone()
            .unwrap_or_else(|| per_profile_cdp_url(base.as_deref(), &launch_state.profile_dir));
        let cdp_port = launch_state
            .cdp_port
            .map(Value::from)
            .unwrap_or(Value::Null);
        active_accounts.push(json!({
            "accountId": account_id,
            "handle": handle,
            "profileDir": launch_state.profile_dir,
            "cdpUrl": cdp_url,
            "cdpPort": cdp_port,
        }));
    }
    active_accounts.retain(|entry| entry.get("accountId").and_then(Value::as_str).is_some());

    let (first_account_id, first_handle, first_profile_dir, first_cdp_url) =
        if let Some(first) = active_accounts.first() {
            (
                first.get("accountId").cloned().unwrap_or(Value::Null),
                first.get("handle").cloned().unwrap_or(Value::Null),
                first.get("profileDir").cloned().unwrap_or(Value::Null),
                first.get("cdpUrl").cloned().unwrap_or(Value::Null),
            )
        } else {
            let first_state = states.first();
            let profile_dir = first_state
                .map(|state| state.profile_dir.clone())
                .unwrap_or_default();
            let cdp_url = first_state
                .and_then(|state| state.cdp_url.clone())
                .unwrap_or_default();
            (
                Value::Null,
                Value::Null,
                json!(profile_dir),
                if cdp_url.is_empty() {
                    Value::Null
                } else {
                    json!(cdp_url)
                },
            )
        };

    Ok(Json(json!({
        "accountId": first_account_id,
        "handle": first_handle,
        "profileDir": first_profile_dir,
        "cdpUrl": first_cdp_url,
        "activeAccounts": active_accounts,
    })))
}

async fn x_session(
    State(state): State<AppState>,
    Query(query): Query<XSessionQuery>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let accounts = repository.list_accounts().await?;
    let lookup = query.account_id.as_deref().unwrap_or("account_personal");
    let account = accounts
        .iter()
        .find(|item| item.id == lookup)
        .cloned()
        .or_else(|| accounts.first().cloned());
    let Some(account) = account else {
        return Err(ApiError::http(404, "Account not found"));
    };
    if let Err(error) = zyquor_accounts::assert_dedicated_profile_dir(&account.profile_dir) {
        return Err(ApiError::Internal(error.to_string()));
    }
    let profile_dir = resolve_profile_dir(&account.profile_dir);
    let enabled = browser_enable_prepare(&state);
    let base = browser_cdp_base(&state);
    let cdp_url = per_profile_cdp_url(base.as_deref(), &account.profile_dir);

    {
        let mut guard = match state.runtime.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.browser_loaded = true;
    }

    match check_x_login(&cdp_url).await {
        Ok(result) => {
            if result.logged_in {
                let mut guard = match state.runtime.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.onboarding.x_session_checked_ok = true;
            }
            Ok(Json(json!({
                "accountId": account.id,
                "cdpUrl": cdp_url,
                "enabled": enabled,
                "error": Value::Null,
                "loggedIn": result.logged_in,
                "observedHandle": result.handle,
                "profileDir": profile_dir,
                "url": result.url,
            })))
        }
        Err(message) => Ok(Json(json!({
            "accountId": account.id,
            "cdpUrl": cdp_url,
            "enabled": enabled,
            "error": message,
            "loggedIn": false,
            "profileDir": profile_dir,
            "url": Value::Null,
        }))),
    }
}

#[derive(Deserialize, Default)]
struct LaunchChromeBody {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

async fn launch_chrome(
    State(state): State<AppState>,
    Json(body): Json<LaunchChromeBody>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let accounts = repository.list_accounts().await?;
    let resolved_id = match body.account_id {
        Some(id) => id,
        None => active_account_id_from_launch_state(&state, &accounts).await,
    };
    let account = accounts.iter().find(|item| item.id == resolved_id);
    let Some(account) = account else {
        return Err(ApiError::http(404, "Account not found"));
    };
    let profile_dir = resolve_profile_dir(&account.profile_dir);
    let base = browser_cdp_base(&state);
    let cdp_url = per_profile_cdp_url(base.as_deref(), &account.profile_dir);
    {
        let mut guard = match state.runtime.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.browser_loaded = true;
    }
    let launched = zyquor_browser::ensure_browser_cdp(&cdp_url, &profile_dir).await;
    if launched {
        Ok(Json(json!({"launched": true})))
    } else {
        Ok(Json(
            json!({"launched": false, "reason": format!("{cdp_url} unavailable")}),
        ))
    }
}
