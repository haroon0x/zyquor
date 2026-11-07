//! The posting-composer flow: open it, type, verify, and (only when the
//! caller asks) click Post. Ported from `preparePost` / `openPostComposer` /
//! the editor helpers in `packages/browser/src/index.ts`.
//!
//! The final post action is never swallowed or auto-retried: a failed click
//! may still have reached X (product rule).

use std::path::PathBuf;

use crate::artifacts;
use crate::login::{assert_not_login_page, read_logged_in_handle};
use crate::page::CdpPage;
use crate::session::Session;

const EDITOR_SELECTOR: &str =
    r#"[data-testid="tweetTextarea_0"], [aria-label*="Post text"], [aria-label*="Tweet text"]"#;
const REPLY_BUTTON_SELECTOR: &str =
    r#"article[data-testid="tweet"] [data-testid="reply"], [data-testid="reply"]"#;

#[derive(Debug, Clone)]
pub struct PreparePostInput {
    pub profile_dir: String,
    pub text: String,
    pub action_delay_ms: Option<u64>,
    pub artifacts_dir: Option<PathBuf>,
    pub cdp_url: String,
    pub media_paths: Option<Vec<String>>,
    pub submit: bool,
    pub typing_delay_ms: Option<u64>,
    pub x_url: Option<String>,
    pub reply_to_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PreparePostResult {
    pub status: String,
    pub inserted_text: String,
    pub post_url: Option<String>,
}

#[derive(Debug)]
pub struct BrowserPrepareError {
    pub message: String,
    pub screenshot_path: Option<PathBuf>,
    pub trace_path: Option<PathBuf>,
}

impl std::fmt::Display for BrowserPrepareError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for BrowserPrepareError {}

fn prepare_error(
    message: impl Into<String>,
    screenshot_path: Option<PathBuf>,
    trace_path: Option<PathBuf>,
) -> BrowserPrepareError {
    BrowserPrepareError {
        message: message.into(),
        screenshot_path,
        trace_path,
    }
}

/// `openPostComposer` from `index.ts`.
pub async fn open_post_composer(
    page: &CdpPage,
    x_url: &str,
    reply_to_url: Option<&str>,
) -> Result<(), String> {
    let target_url = reply_to_url.unwrap_or(x_url);
    if !page.url().await.starts_with(target_url) {
        match page.goto(target_url, 45_000).await {
            Ok(()) => {}
            Err(error) => {
                let current_url = page.url().await;
                if !error.contains("Timeout") || !current_url.starts_with(target_url) {
                    return Err(error);
                }
            }
        }
    }

    if reply_to_url.is_some() {
        // X occasionally serves a half-rendered status page where the reply
        // button never mounts. Reload once and wait again before giving up:
        // the click has not happened yet, so re-waiting cannot duplicate a
        // post; it only avoids recording slow renders as failed jobs.
        match page.click_selector(REPLY_BUTTON_SELECTOR, 15_000).await {
            Ok(()) => {}
            Err(_) => {
                let _ = page.reload(45_000).await;
                tokio::time::sleep(std::time::Duration::from_millis(2_000)).await;
                page.click_selector(REPLY_BUTTON_SELECTOR, 20_000).await?;
            }
        }
    }

    Ok(())
}

async fn type_into_editor(page: &CdpPage, text: &str, typing_delay_ms: u64) -> Result<(), String> {
    match page.focus(EDITOR_SELECTOR).await {
        Ok(true) => {}
        Ok(false) | Err(_) => {
            // Shells that ignore programmatic focus until the first pointer
            // action: force-click without actionability waits.
            page.click_selector(EDITOR_SELECTOR, 15_000).await?;
        }
    }
    // Clear: select the whole contenteditable and delete.
    let _ = page
        .evaluate_value(
            r#"(() => {
                const target = document.querySelector('[data-testid="tweetTextarea_0"], [aria-label*="Post text"], [aria-label*="Tweet text"]');
                if (!target) return false;
                target.focus();
                const range = document.createRange();
                range.selectNodeContents(target);
                document.getSelection()?.removeAllRanges();
                document.getSelection()?.addRange(range);
                return true;
            })()"#,
        )
        .await;
    press_key_chord(page, "Control+a").await;
    press_key_chord(page, "Backspace").await;
    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    page.insert_text(text).await?;
    if typing_delay_ms > 0 {
        tokio::time::sleep(std::time::Duration::from_millis(
            (typing_delay_ms * 4).min(500),
        ))
        .await;
    }
    Ok(())
}

async fn press_key_chord(page: &CdpPage, chord: &str) {
    let params = if chord.starts_with("Control+") {
        let key = chord.trim_start_matches("Control+").to_lowercase();
        chromiumoxide::cdp::browser_protocol::input::DispatchKeyEventParams::builder()
            .r#type(chromiumoxide::cdp::browser_protocol::input::DispatchKeyEventType::KeyDown)
            .modifiers(2)
            .text(key)
            .build()
    } else {
        chromiumoxide::cdp::browser_protocol::input::DispatchKeyEventParams::builder()
            .r#type(chromiumoxide::cdp::browser_protocol::input::DispatchKeyEventType::KeyDown)
            .key(chord.to_string())
            .text(chord.to_string())
            .build()
    };
    if let Ok(params) = params {
        let _ = page.chromiumoxide_page().execute(params).await;
    }
}

async fn read_inserted_text(page: &CdpPage) -> String {
    if let Ok(value) = page
        .evaluate_value(
            r#"(() => {
                const target = [...document.querySelectorAll('[data-testid="tweetTextarea_0"], [aria-label*="Post text"], [aria-label*="Tweet text"]')]
                    .find((candidate) => {
                        const rect = candidate.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    });
                return target?.textContent ?? null;
            })()"#,
        )
        .await
    {
        if let Some(text) = value.as_str() {
            if !text.trim().is_empty() {
                return text.trim().to_string();
            }
        }
    }
    if let Ok(all) = page
        .evaluate::<Vec<String>>(
            r#"(() => {
                return [...document.querySelectorAll('[data-testid="tweetTextarea_0"], [aria-label*="Post text"], [aria-label*="Tweet text"]')]
                    .map((candidate) => (candidate.textContent ?? "").trim())
                    .filter((value) => value.length > 0);
            })()"#,
        )
        .await
    {
        if let Some(first) = all.into_iter().next() {
            return first;
        }
    }
    String::new()
}

async fn upload_media(page: &CdpPage, media_paths: &[String]) -> Result<(), String> {
    if media_paths.is_empty() {
        return Ok(());
    }
    use chromiumoxide::cdp::browser_protocol::dom::{
        GetDocumentParams, QuerySelectorParams, SetFileInputFilesParams,
    };
    let document = page
        .chromiumoxide_page()
        .execute(GetDocumentParams::default())
        .await
        .map_err(|error| error.to_string())?;
    let input = page
        .chromiumoxide_page()
        .execute(
            QuerySelectorParams::builder()
                .node_id(document.root.node_id)
                .selector(r#"input[type="file"][data-testid="fileInput"], input[type="file"]"#)
                .build()
                .map_err(|error| error.to_string())?,
        )
        .await
        .map_err(|error| error.to_string())?;
    let node_id = input.node_id;
    page.chromiumoxide_page()
        .execute(
            SetFileInputFilesParams::builder()
                .node_id(node_id)
                .files(media_paths.to_vec())
                .build()
                .map_err(|error| error.to_string())?,
        )
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn enabled_post_button_center(page: &CdpPage) -> Result<(f64, f64), String> {
    let selectors = [
        r#"[data-testid="tweetButton"]"#,
        r#"[data-testid="tweetButtonInline"]"#,
        r#"[role="button"]"#,
    ];
    for selector in selectors {
        let center = page
            .evaluate_value(&format!(
                r#"(() => {{
                    const candidates = [...document.querySelectorAll({selector_json})]
                        .filter((element) => {{
                            if (element.getAttribute("aria-disabled") === "true" || element.disabled) return false;
                            const rect = element.getBoundingClientRect();
                            if (rect.width === 0 || rect.height === 0) return false;
                            return true;
                        }});
                    const element = candidates[candidates.length - 1] ?? null;
                    if (!element) return null;
                    const rect = element.getBoundingClientRect();
                    return {{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }};
                }})()"#,
                selector_json = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string())
            ))
            .await;
        if let Ok(value) = center {
            if let (Some(x), Some(y)) = (
                value.get("x").and_then(serde_json::Value::as_f64),
                value.get("y").and_then(serde_json::Value::as_f64),
            ) {
                return Ok((x, y));
            }
        }
    }
    Err("Enabled X Post button could not be found".to_string())
}

async fn resolve_posted_permalink(
    page: &CdpPage,
    handle: Option<&str>,
    text: Option<&str>,
) -> Option<String> {
    let wanted_handle = handle
        .map(|handle| handle.trim().trim_start_matches('@').to_lowercase())
        .filter(|handle| !handle.is_empty());
    let wanted_text = text
        .map(|text| {
            text.split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(60)
                .collect::<String>()
        })
        .filter(|text| !text.is_empty());

    let permalink_for_owner = |url: &str, handle: &Option<String>| -> Option<String> {
        let permalink = extract_status_permalink(url)?;
        match handle {
            None => Some(permalink),
            Some(wanted) => {
                if permalink
                    .to_lowercase()
                    .contains(&format!("/{wanted}/status/"))
                {
                    Some(permalink)
                } else {
                    None
                }
            }
        }
    };

    if let Some(location) = permalink_for_owner(&page.url().await, &wanted_handle) {
        return Some(location);
    }

    if let Some(permalink) =
        article_permalink_matching(page, wanted_handle.as_deref(), wanted_text.as_deref()).await
    {
        return Some(permalink);
    }

    let start_ms = chrono::Utc::now().timestamp_millis();
    loop {
        if chrono::Utc::now().timestamp_millis() - start_ms >= 5_000 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        if let Some(extracted) = permalink_for_owner(&page.url().await, &wanted_handle) {
            return Some(extracted);
        }
        if let Some(permalink) =
            article_permalink_matching(page, wanted_handle.as_deref(), wanted_text.as_deref()).await
        {
            return Some(permalink);
        }
    }

    if wanted_handle.is_some() {
        return None;
    }

    let links = page
        .evaluate::<Vec<String>>(
            r#"(() => {
                return [...document.querySelectorAll('a[href*="/status/"]')]
                    .map((link) => link.getAttribute("href") ?? "")
                    .filter(Boolean);
            })()"#,
        )
        .await
        .unwrap_or_default();
    for link in links {
        if let Some(permalink) = extract_status_permalink(&link) {
            return Some(permalink);
        }
    }
    None
}

#[derive(Debug, Clone, serde::Deserialize)]
struct ArticleRow {
    #[serde(default)]
    link: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    text: String,
}

async fn article_permalink_matching(
    page: &CdpPage,
    wanted_handle: Option<&str>,
    wanted_text: Option<&str>,
) -> Option<String> {
    let rows: Vec<ArticleRow> = page
        .evaluate(
            r#"(() => {
                return [...document.querySelectorAll("article[data-testid='tweet']")].map((article) => ({
                    link: article.querySelector("a[href*='/status/']")?.getAttribute("href") ?? "",
                    author: article.querySelector("[data-testid='User-Name'] a[href^='/']")?.getAttribute("href") ?? "",
                    text: (article.querySelector("[data-testid='tweetText']")?.textContent ?? "").replace(/\s+/g, " ").trim()
                }));
            })()"#,
        )
        .await
        .ok()?;

    for row in rows {
        let author = row
            .author
            .trim_start_matches('/')
            .trim_start_matches('@')
            .to_lowercase();
        if let Some(wanted) = wanted_handle {
            if author != wanted {
                continue;
            }
        }
        if let Some(wanted) = wanted_text {
            if !row
                .text
                .contains(&wanted.chars().take(40).collect::<String>())
            {
                continue;
            }
        }
        if let Some(permalink) = extract_status_permalink(&row.link) {
            return Some(permalink);
        }
    }
    None
}

pub fn extract_status_permalink(url: &str) -> Option<String> {
    for prefix in ["https://x.com/", "https://twitter.com/"] {
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
    let marker = "/status/";
    if let Some(index) = url.find(marker) {
        let after = &url[index + marker.len()..];
        let handle = url[..index].rsplit('/').next().unwrap_or("");
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !handle.is_empty() && !digits.is_empty() {
            return Some(format!("https://x.com/{handle}/status/{digits}"));
        }
    }
    None
}

async fn visible_editor_texts(page: &CdpPage) -> Vec<String> {
    page.evaluate::<Vec<String>>(
        r#"(() => {
            return [...document.querySelectorAll('[data-testid="tweetTextarea_0"], [aria-label*="Post text"], [aria-label*="Tweet text"]')]
                .map((candidate) => (candidate.textContent ?? "").trim());
        })()"#,
    )
    .await
    .unwrap_or_default()
}

pub async fn prepare_post(
    session: &Session,
    input: &PreparePostInput,
) -> Result<PreparePostResult, BrowserPrepareError> {
    let text = input.text.trim().to_string();
    if text.is_empty() {
        return Err(prepare_error("Post text is empty", None, None));
    }

    let action_delay_ms = input.action_delay_ms.unwrap_or(1_800);
    let typing_delay_ms = input.typing_delay_ms.unwrap_or(20);
    let artifacts_dir = input
        .artifacts_dir
        .clone()
        .unwrap_or_else(artifacts::default_artifacts_dir);
    let _ = artifacts::ensure_artifacts_dir(&artifacts_dir);
    let stamp = artifacts::artifact_stamp();
    let screenshot_path = artifacts_dir.join(format!("prepare-{stamp}.png"));
    let trace_path = artifacts_dir.join(format!("prepare-{stamp}.json"));

    let page = page_for_post(session, input).await.map_err(|error| {
        prepare_error(
            error,
            Some(screenshot_path.clone()),
            Some(trace_path.clone()),
        )
    })?;
    let page = CdpPage::new(page);

    let _ = page.bring_to_front().await;
    let _ = crate::tracing::start_tracing(&page).await;
    if let Err(error) = open_post_composer(
        &page,
        input
            .x_url
            .as_deref()
            .unwrap_or("https://x.com/compose/post"),
        input.reply_to_url.as_deref(),
    )
    .await
    {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        let _ = crate::tracing::stop_tracing(&page, &trace_path).await;
        return Err(prepare_error(error, Some(screenshot_path.clone()), None));
    }
    tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;

    if let Err(error) = assert_not_login_page(&page).await {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(prepare_error(error, Some(screenshot_path.clone()), None));
    }

    let _ = page.wait_for_visible(EDITOR_SELECTOR, 30_000).await;
    tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;

    if let Err(error) = type_into_editor(&page, &text, typing_delay_ms).await {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(prepare_error(error, Some(screenshot_path.clone()), None));
    }
    tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;

    if let Some(media_paths) = &input.media_paths {
        if let Err(error) = upload_media(&page, media_paths).await {
            let _ = page.screenshot_full_page(&screenshot_path).await;
            return Err(prepare_error(error, Some(screenshot_path.clone()), None));
        }
    }
    tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;

    let inserted_text = read_inserted_text(&page).await;
    if !inserted_text.contains(&text) {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(prepare_error(
            "Inserted text could not be verified",
            Some(screenshot_path.clone()),
            None,
        ));
    }

    if !input.submit {
        return Ok(PreparePostResult {
            status: "prepared".to_string(),
            inserted_text,
            post_url: None,
        });
    }

    let post_center = match enabled_post_button_center(&page).await {
        Ok(center) => center,
        Err(error) => {
            let _ = page.screenshot_full_page(&screenshot_path).await;
            return Err(prepare_error(error, Some(screenshot_path.clone()), None));
        }
    };
    tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;
    let posted_by = read_logged_in_handle(&page).await.ok().flatten();
    let _ = page
        .chromiumoxide_page()
        .click(chromiumoxide::layout::Point::new(
            post_center.0,
            post_center.1,
        ))
        .await;
    tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms.max(4_000))).await;

    let start_ms = chrono::Utc::now().timestamp_millis();
    let mut post_url = None;
    loop {
        if chrono::Utc::now().timestamp_millis() - start_ms >= 15_000 {
            break;
        }
        let cleared = visible_editor_texts(&page)
            .await
            .iter()
            .all(|value| !value.contains(&text));
        if cleared {
            break;
        }
        post_url = resolve_posted_permalink(&page, posted_by.as_deref(), Some(&text)).await;
        if post_url.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1_000)).await;
    }

    let editor_cleared = visible_editor_texts(&page)
        .await
        .iter()
        .all(|value| !value.contains(&text));
    if !editor_cleared && post_url.is_none() {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(prepare_error(
            "X Post click did not clear the compose text",
            Some(screenshot_path.clone()),
            None,
        ));
    }
    if post_url.is_none() {
        post_url = resolve_posted_permalink(&page, posted_by.as_deref(), Some(&text)).await;
    }
    match post_url {
        Some(post_url) => Ok(PreparePostResult {
            status: "posted".to_string(),
            inserted_text,
            post_url: Some(post_url),
        }),
        None => Err(prepare_error(
            "Posted tweet permalink could not be verified after X Post click",
            Some(screenshot_path.clone()),
            None,
        )),
    }
}

async fn page_for_post(
    session: &Session,
    input: &PreparePostInput,
) -> Result<chromiumoxide::Page, String> {
    crate::session::close_duplicate_x_pages(session).await?;
    if let Some(page) = session.existing_x_page().await? {
        return Ok(page);
    }
    if !input.cdp_url.is_empty() {
        return Err(
            "No existing X tab is open in Chrome CDP. Open one X tab and retry.".to_string(),
        );
    }
    session.first_page_or_new().await
}
