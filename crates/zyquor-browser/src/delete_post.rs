//! Delete-own-post flow, ported from `deletePost` in
//! `packages/browser/src/index.ts`.

use std::path::PathBuf;

use crate::artifacts;
use crate::fetched_types;
use crate::login::assert_not_login_page;
use crate::page::CdpPage;
use crate::session::Session;

#[derive(Debug, Clone)]
pub struct DeletePostInput {
    pub profile_dir: String,
    pub post_url: String,
    pub cdp_url: String,
    pub action_delay_ms: Option<u64>,
    pub artifacts_dir: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct DeletePostResult {
    pub status: String,
    pub post_url: String,
    pub already_deleted: bool,
}

#[derive(Debug)]
pub struct BrowserDeleteError {
    pub message: String,
    pub screenshot_path: Option<PathBuf>,
}

impl std::fmt::Display for BrowserDeleteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for BrowserDeleteError {}

fn browser_delete_error(
    message: impl Into<String>,
    screenshot_path: Option<PathBuf>,
) -> BrowserDeleteError {
    BrowserDeleteError {
        message: message.into(),
        screenshot_path,
    }
}

async fn page_shows_nonexistent_tweet(page: &CdpPage) -> bool {
    page.evaluate_value(
        r#"(() => {
            const body = document.body?.innerText ?? "";
            return /this page doesn.t exist/i.test(body) && /try searching for something else/i.test(body);
        })()"#,
    )
    .await
    .map(|value| value == serde_json::Value::Bool(true))
    .unwrap_or(false)
}

async fn tweet_article_visible(page: &CdpPage, tweet_id: &str) -> bool {
    page.evaluate_value(&format!(
        r#"(() => {{
            const article = [...document.querySelectorAll('article[data-testid="tweet"]')]
                .some((article) => !!article.querySelector('a[href*="/status/{}"]'));
            if (!article) return false;
            const rect = article.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }})()"#,
        tweet_id
    ))
    .await
    .map(|value| value == serde_json::Value::Bool(true))
    .unwrap_or(false)
}

pub async fn delete_post(
    session: &Session,
    input: &DeletePostInput,
) -> Result<DeletePostResult, BrowserDeleteError> {
    let permalink = extract_status_permalink(&input.post_url).ok_or_else(|| {
        browser_delete_error(
            format!("Not a valid X status URL: {}", input.post_url),
            None,
        )
    })?;
    let tweet_id = fetched_types::tweet_id_from_status_url(&permalink).ok_or_else(|| {
        browser_delete_error(
            format!("Could not read the tweet id from {permalink}"),
            None,
        )
    })?;

    let action_delay_ms = input.action_delay_ms.unwrap_or(1_800);
    let artifacts_dir = input
        .artifacts_dir
        .clone()
        .unwrap_or_else(artifacts::default_artifacts_dir);
    artifacts::ensure_artifacts_dir(&artifacts_dir)
        .map_err(|error| browser_delete_error(error, None))?;
    let screenshot_path = artifacts::artifact_path(&artifacts_dir, "delete");

    let page = session
        .new_page()
        .await
        .map_err(|error| browser_delete_error(error, None))?;
    let _ = page.goto(&permalink, 45_000).await;

    let mut resolved = tweet_article_visible(&page, &tweet_id).await;
    if !resolved {
        if page_shows_nonexistent_tweet(&page).await {
            return Ok(DeletePostResult {
                status: "deleted".to_string(),
                post_url: permalink,
                already_deleted: true,
            });
        }
        for _attempt in 0..2 {
            if resolved {
                break;
            }
            let _ = page.reload(30_000).await;
            resolved = tweet_article_visible(&page, &tweet_id).await;
            if page_shows_nonexistent_tweet(&page).await {
                return Ok(DeletePostResult {
                    status: "deleted".to_string(),
                    post_url: permalink,
                    already_deleted: true,
                });
            }
        }
    }
    if !resolved {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(browser_delete_error(
            format!("Own tweet article {tweet_id} did not render at {permalink}"),
            Some(screenshot_path),
        ));
    }

    if let Err(error) = assert_not_login_page(&page).await {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(browser_delete_error(error, Some(screenshot_path.clone())));
    }
    tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;

    // Caret menu → Delete; fall back to the exact-text variants when the role
    // locator does not appear.
    let caret_selector = r#"article[data-testid="tweet"] [data-testid="caret"]"#.to_string();
    if page.click_selector(&caret_selector, 15_000).await.is_err() {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(browser_delete_error(
            "the caret menu click failed",
            Some(screenshot_path),
        ));
    }

    let delete_item = menu_item_selector();
    let _ = page.wait_for_visible(&delete_item, 10_000).await.is_ok();
    click_with_fallback(
        &page,
        &delete_item,
        10_000,
        &screenshot_path,
        "Delete menu item did not appear for the tweet",
    )
    .await?;

    let confirm_selector = r#"[data-testid="confirmationSheetConfirm"]"#;
    let confirm_visible = page
        .wait_for_visible(confirm_selector, 10_000)
        .await
        .is_ok();
    if confirm_visible {
        page.click_selector(confirm_selector, 10_000)
            .await
            .map_err(|error| browser_delete_error(error, Some(screenshot_path.clone())))?;
    } else {
        let fallback_selector = r#"[role="button"]"#;
        page.click_by_text(fallback_selector, "Delete", 10_000)
            .await
            .map_err(|error| browser_delete_error(error, Some(screenshot_path.clone())))?;
    }

    let mut verified = false;
    if let Ok(()) = page
        .wait_for_visible(r#"text=Your post was deleted"#, 15_000)
        .await
    {
        let _ = ();
        verified = true;
    } else if !(tweet_article_visible(&page, &tweet_id).await)
        || page_shows_nonexistent_tweet(&page).await
    {
        verified = true;
    }
    if !verified {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(browser_delete_error(
            "Delete click did not visibly remove the tweet",
            Some(screenshot_path),
        ));
    }

    Ok(DeletePostResult {
        status: "deleted".to_string(),
        post_url: permalink,
        already_deleted: false,
    })
}

fn menu_item_selector() -> String {
    r#"[data-testid="Dropdown"] [role="menuitem"]"#.to_string()
}

async fn click_with_fallback(
    page: &CdpPage,
    selector: &str,
    timeout_ms: u64,
    screenshot_path: &std::path::Path,
    failure_message: &str,
) -> Result<(), BrowserDeleteError> {
    match page.click_selector(selector, timeout_ms).await {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = error;
            let _ = page.screenshot_full_page(screenshot_path).await;
            Err(browser_delete_error(
                failure_message,
                Some(screenshot_path.to_path_buf()),
            ))
        }
    }
}

pub fn extract_status_permalink(url: &str) -> Option<String> {
    let marker = "https://x.com/";
    let twitter_marker = "https://twitter.com/";
    for prefix in [marker, twitter_marker] {
        if let Some(rest) = url.strip_prefix(prefix) {
            let parts: Vec<&str> = rest.split('/').collect();
            if parts.len() >= 3 && !parts[0].is_empty() && parts[1] == "status" {
                return Some(format!(
                    "https://x.com/{}/{}/{}",
                    parts[0], parts[1], parts[2]
                ));
            }
        }
    }
    None
}
