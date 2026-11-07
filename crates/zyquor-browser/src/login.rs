//! Login detection, ported from `checkXLogin` / `assertNotLoginPage` /
//! `readLoggedInHandle` in `packages/browser/src/index.ts`.

use crate::page::CdpPage;
use crate::session::Session;

#[derive(Debug, Clone)]
pub struct CheckXLoginResult {
    pub logged_in: bool,
    pub url: String,
    pub handle: Option<String>,
}

pub async fn check_x_login(
    session: &Session,
    x_home_url: &str,
) -> Result<CheckXLoginResult, String> {
    let page = page_for_session_check(session, x_home_url).await?;
    assert_not_login_page(&page).await?;
    let handle = read_logged_in_handle(&page).await.ok().flatten();
    Ok(CheckXLoginResult {
        logged_in: true,
        url: page.url().await,
        handle,
    })
}

/// The pre-browsing check: are we on an X page, or a login form?
pub async fn assert_not_login_page(page: &CdpPage) -> Result<(), String> {
    let url = page.url().await;
    let parsed = url::Url::parse(&url).ok();
    let login_onboarding = parsed.as_ref().is_some_and(|parsed| {
        parsed.path().starts_with("/i/jf/onboarding/")
            && (parsed
                .query_pairs()
                .any(|(key, value)| key == "mode" && value == "login")
                || parsed
                    .query_pairs()
                    .any(|(key, _)| key == "redirect_after_login"))
    });

    if url.contains("/login") || url.contains("/i/flow/login") || login_onboarding {
        return Err(login_not_logged_in_message());
    }

    for attempt in 0..3 {
        if is_login_form_ready(page).await {
            return Err(login_not_logged_in_message());
        }
        if is_authenticated_shell(page).await {
            return Ok(());
        }
        if attempt < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(2_000)).await;
        }
    }

    if let Ok(Some(handle)) = read_logged_in_handle(page).await {
        return Err(format!(
            "X did not render the authenticated shell at {} even though the session is valid (@{handle}). \
             This is a rendered-page failure, not a logout: relaunch the browser profile and retry, \
             do not clear cookies.",
            page.url().await
        ));
    }
    Err(login_not_logged_in_message())
}

fn login_not_logged_in_message() -> String {
    "X profile is not logged in. Run `pnpm profile:x:manual`, log into X, close that browser, then retry."
        .to_string()
}

async fn is_login_form_ready(page: &CdpPage) -> bool {
    page.evaluate_value(
        r#"(() => {
            return !!document.querySelector('input[name="text"], input[name="password"], [data-testid="loginButton"], a[href="/login"]');
        })()"#,
    )
    .await
    .map(|value| value == serde_json::Value::Bool(true))
    .unwrap_or(false)
}

async fn is_authenticated_shell(page: &CdpPage) -> bool {
    page.evaluate_value(
        r#"(() => {
            return !!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"], a[data-testid="AppTabBar_Profile_Link"]');
        })()"#,
    )
    .await
    .map(|value| value == serde_json::Value::Bool(true))
    .unwrap_or(false)
}

/// Which account is REALLY logged in? Prefer the side-nav profile link, then
/// fall back to the credentials endpoint with the `ct0` CSRF cookie — exactly
/// what the X web client does. Guards every downstream action against
/// posting from the wrong account.
pub async fn read_logged_in_handle(page: &CdpPage) -> Result<Option<String>, String> {
    let raw = page
        .evaluate_value(
            r#"(() => {
            const profileLink = document
                .querySelector('a[data-testid="AppTabBar_Profile_Link"]')
                ?.getAttribute("href");
            if (profileLink && /^\/[A-Za-z0-9_]{1,15}\/?$/.test(profileLink)) {
                return profileLink.replace(/^\//, "").replace(/\/$/, "");
            }
            try {
                const csrf = document.cookie
                    .split("; ")
                    .find((cookie) => cookie.startsWith("ct0="))
                    ?.split("=")[1];
                return fetch(
                    "/i/api/1.1/account/verify_credentials.json?skip_status=1",
                    {
                        credentials: "include",
                        headers: csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {}
                    }
                )
                    .then((response) => {
                        if (!response.ok) return null;
                        return response.json();
                    })
                    .then((data) => (typeof data?.screen_name === "string" ? data.screen_name : null))
                    .catch(() => null);
            } catch {
                return null;
            }
        })()"#,
        )
        .await
        .map_err(|error| error.to_string())?;

    let normalized = raw
        .as_str()
        .unwrap_or("")
        .trim()
        .trim_start_matches('@')
        .to_lowercase();
    if !normalized.is_empty()
        && normalized.len() <= 15
        && normalized
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        Ok(Some(normalized))
    } else {
        Ok(None)
    }
}

pub async fn page_for_session_check(
    session: &Session,
    x_home_url: &str,
) -> Result<CdpPage, String> {
    crate::session::close_duplicate_x_pages(session).await?;
    if let Some(page) = session.existing_x_page().await? {
        let page = CdpPage::new(page);
        session.install_dialog_dismissers(page.chromiumoxide_page());
        return Ok(page);
    }
    let page = session.new_page().await?;
    let _ = page.goto(x_home_url, 15_000).await;
    session.install_dialog_dismissers(page.chromiumoxide_page());
    Ok(page)
}
