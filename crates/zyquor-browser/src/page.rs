//! Low-level page primitives over chromiumoxide, replacing the pieces of
//! Playwright the TypeScript port relied on: visibility/actionability waits,
//! element clicking, text insertion, and evaluate-based DOM reads.
//!
//! The module is deliberately small because every flow (composer, login,
//! feed fetch, delete) is built from these primitives. Where Playwright
//! applied actionability checks internally (visible, hit-target, enabled),
//! this module reimplements them with `Runtime.evaluate` polls.
//!
//! The one gap versus Playwright that this module does NOT have: a bottom-up
//! "stable across frames" check. The click routines wait for one poll
//! interval between scroll-into-view and the hit test, which covers the
//! common React re-mount; a genuinely animated element can still slip
//! through. This is accepted and documented — see the module doc below.

use chromiumoxide::Page;
use chromiumoxide::cdp::browser_protocol::input::InsertTextParams;

/// One page whose primitives compose all flows.
#[derive(Debug)]
pub struct CdpPage {
    page: Page,
}

impl CdpPage {
    pub fn new(page: Page) -> Self {
        Self { page }
    }

    pub fn chromiumoxide_page(&self) -> &Page {
        &self.page
    }

    /// Current URL (`page.url()` in Playwright; `undefined` → `""`).
    pub async fn url(&self) -> String {
        self.page.url().await.ok().flatten().unwrap_or_default()
    }

    /// Navigate, waiting for the navigation cycle (Playwright `waitUntil:
    /// "domcontentloaded"` equivalent).
    pub async fn goto(&self, url: &str, timeout_ms: u64) -> Result<(), String> {
        match tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            self.page.goto(url),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(error.to_string()),
            Err(_) => Err("navigation timed out".to_string()),
        }
    }

    pub async fn reload(&self, timeout_ms: u64) -> Result<(), String> {
        match tokio::time::timeout(
            std::time::Duration::from_millis(timeout_ms),
            self.page.reload(),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(error.to_string()),
            Err(_) => Err("reload timed out".to_string()),
        }
    }

    /// Evaluate `expression` and decode the JSON value it returns
    /// (`returnByValue: true`, required for structured results).
    pub async fn evaluate_value(&self, expression: &str) -> Result<serde_json::Value, String> {
        let params = chromiumoxide::cdp::js_protocol::runtime::EvaluateParams::builder()
            .expression(expression)
            .return_by_value(true)
            .build()
            .map_err(|error| error.to_string())?;
        match self.page.evaluate_expression(params).await {
            Ok(result) => result
                .value()
                .cloned()
                .ok_or_else(|| "evaluate returned no JSON value".to_string()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub async fn evaluate<T: serde::de::DeserializeOwned>(
        &self,
        expression: &str,
    ) -> Result<T, String> {
        let value = self.evaluate_value(expression).await?;
        serde_json::from_value(value).map_err(|error| error.to_string())
    }

    /// `page.bringToFront()` — restores a minimized/occluded window, which
    /// restores animation frames for actionability checks.
    pub async fn bring_to_front(&self) {
        let _ = self.page.bring_to_front().await;
    }

    /// Best (largest) visible element matching `selector`, mirroring the
    /// `firstVisibleEditor` logic. Returns its center coordinates.
    pub async fn best_visible_center(&self, selector: &str) -> Result<(f64, f64), String> {
        let expression = format!(
            r#"(() => {{
                const elements = [...document.querySelectorAll({})];
                let best = null;
                let bestArea = -1;
                for (const element of elements) {{
                    const style = getComputedStyle(element);
                    if (style.visibility === 'hidden' || style.display === 'none') continue;
                    const rect = element.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    const area = rect.width * rect.height;
                    if (area > bestArea) {{
                        bestArea = area;
                        best = {{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }};
                    }}
                }}
                return best;
            }})()"#,
            json_string(selector)
        );
        let value = self.evaluate_value(&expression).await?;
        match (
            value.get("x").and_then(serde_json::Value::as_f64),
            value.get("y").and_then(serde_json::Value::as_f64),
        ) {
            (Some(x), Some(y)) => Ok((x, y)),
            _ => Err("no visible element matched the selector".to_string()),
        }
    }

    /// Click the best visible element matching `selector`: poll the
    /// actionability gate until it passes, then dispatch the mouse click.
    pub async fn click_selector(&self, selector: &str, timeout_ms: u64) -> Result<(), String> {
        let deadline = chrono::Utc::now().timestamp_millis() + timeout_ms as i64;
        loop {
            match self.click_once(selector).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if chrono::Utc::now().timestamp_millis() >= deadline {
                        return Err(error);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        }
    }

    async fn click_once(&self, selector: &str) -> Result<(), String> {
        self.scroll_into_view(selector).await;
        // One poll interval lets the scroll paint; the hit test then gates
        // the click exactly like the TS actionability checks.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if !is_actionable(self, selector).await {
            return Err("element is not actionable".to_string());
        }
        let center = self.best_visible_center(selector).await?;
        self.page
            .click(chromiumoxide::layout::Point::new(center.0, center.1))
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// Poll until at least one element matching `selector` is visible
    /// (non-zero box, not `display:none`/`visibility:hidden`).
    pub async fn wait_for_visible(&self, selector: &str, timeout_ms: u64) -> Result<(), String> {
        let deadline = chrono::Utc::now().timestamp_millis() + timeout_ms as i64;
        loop {
            if is_any_visible(self, selector).await {
                return Ok(());
            }
            if chrono::Utc::now().timestamp_millis() >= deadline {
                return Err(format!("selector {selector} did not become visible"));
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    }

    pub async fn scroll_into_view(&self, selector: &str) {
        let expression = format!(
            r#"(() => {{
                const element = [...document.querySelectorAll({})]
                    .find((element) => {{
                        const rect = element.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    }});
                if (element) element.scrollIntoView({{ block: "center" }});
                return true;
            }})()"#,
            json_string(selector)
        );
        let _ = self.evaluate_value(&expression).await;
    }

    /// Type `text` into the currently focused element (`Input.insertText`).
    /// Assumes the editor is already focused; the caller owns focus.
    pub async fn insert_text(&self, text: &str) -> Result<(), String> {
        let params = InsertTextParams::builder()
            .text(text.to_string())
            .build()
            .map_err(|error| error.to_string())?;
        self.page
            .execute(params)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// Focus the element matching `selector`.
    pub async fn focus(&self, selector: &str) -> Result<bool, String> {
        let expression = format!(
            r#"(() => {{
                const target = document.querySelector({});
                if (!target) return false;
                target.focus();
                const active = document.activeElement;
                return active === target || (active !== null && target.contains(active));
            }})()"#,
            json_string(selector)
        );
        match self.evaluate_value(&expression).await {
            Ok(serde_json::Value::Bool(focused)) => Ok(focused),
            Ok(_) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub async fn screenshot(&self, path: &std::path::Path) -> Result<(), String> {
        let bytes = self
            .page
            .screenshot(chromiumoxide::page::ScreenshotParams::default())
            .await
            .map_err(|error| error.to_string())?;
        std::fs::write(path, &bytes).map_err(|error| error.to_string())
    }

    /// Full-page screenshot (the TS path used `fullPage: true`).
    pub async fn screenshot_full_page(&self, path: &std::path::Path) -> Result<(), String> {
        let bytes = self
            .page
            .screenshot(
                chromiumoxide::page::ScreenshotParams::builder()
                    .full_page(true)
                    .build(),
            )
            .await
            .map_err(|error| error.to_string())?;
        std::fs::write(path, &bytes).map_err(|error| error.to_string())
    }

    /// Stop tracing if possible, dropping events at `path` when given.
    pub async fn stop_tracing(&self, path: Option<&std::path::Path>) -> Result<(), String> {
        if let Some(path) = path {
            let _ = crate::tracing::stop_tracing(self, path).await;
        }
        Ok(())
    }

    /// Click the element matching `selector` whose OWN text equals `text`
    /// (mirrors Playwright `getByRole(name)` lookups in the TS port).
    pub async fn click_by_text(
        &self,
        selector: &str,
        text: &str,
        timeout_ms: u64,
    ) -> Result<(), String> {
        let deadline = chrono::Utc::now().timestamp_millis() + timeout_ms as i64;
        loop {
            match self.click_by_text_once(selector, text).await {
                Ok(()) => return Ok(()),
                Err(error) => {
                    if chrono::Utc::now().timestamp_millis() >= deadline {
                        return Err(error);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        }
    }

    async fn click_by_text_once(&self, selector: &str, text: &str) -> Result<(), String> {
        let expression = format!(
            r#"(() => {{
                const element = [...document.querySelectorAll({selector_json})]
                    .find((candidate) => (candidate.textContent ?? "").trim() === {text_json});
                if (!element) return null;
                const rect = element.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return null;
                return {{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }};
            }})()"#,
            selector_json = json_string(selector),
            text_json = json_string(text),
        );
        let value = self.evaluate_value(&expression).await?;
        match (
            value.get("x").and_then(serde_json::Value::as_f64),
            value.get("y").and_then(serde_json::Value::as_f64),
        ) {
            (Some(x), Some(y)) => self
                .page
                .click(chromiumoxide::layout::Point::new(x, y))
                .await
                .map(|_| ())
                .map_err(|error| error.to_string()),
            _ => Err(format!("no element with text {text:?} matched {selector}")),
        }
    }

    /// Mouse-wheel scroll (`page.mouse.wheel` in Playwright).
    pub async fn mouse_wheel(&self, delta_x: f64, delta_y: f64) -> Result<(), String> {
        let params =
            chromiumoxide::cdp::browser_protocol::input::DispatchMouseEventParams::builder()
                .r#type(
                    chromiumoxide::cdp::browser_protocol::input::DispatchMouseEventType::MouseWheel,
                )
                .x(0.0)
                .y(0.0)
                .delta_x(delta_x)
                .delta_y(delta_y)
                .build()
                .map_err(|error| error.to_string())?;
        self.page
            .execute(params)
            .await
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// `window.scrollBy(0, pixels)` in page JS.
    pub async fn scroll_by(&self, pixels: i32) -> Result<(), String> {
        let expression = format!("window.scrollBy(0, {pixels})");
        self.evaluate_value(&expression).await.map(|_| ())
    }

    pub async fn close(&self) {
        let _ = self.page.clone().close().await;
    }
}

async fn is_any_visible(page: &CdpPage, selector: &str) -> bool {
    let expression = format!(
        r#"(() => {{
            for (const element of document.querySelectorAll({})) {{
                const style = getComputedStyle(element);
                if (style.visibility === 'hidden' || style.display === 'none') continue;
                const rect = element.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) return true;
            }}
            return false;
        }})()"#,
        json_string(selector)
    );
    page.evaluate_value(&expression)
        .await
        .map(|value| value == serde_json::Value::Bool(true))
        .unwrap_or(false)
}

/// Visibility + enabled + hit-target gates. The hit test uses the element's
/// own center (`document.elementFromPoint`), mirroring Playwright's
/// hit-target actionability check.
async fn is_actionable(page: &CdpPage, selector: &str) -> bool {
    let expression = format!(
        r#"(() => {{
            const element = document.querySelector({});
            if (!element) return false;
            const style = getComputedStyle(element);
            const ariaDisabled = element.getAttribute("aria-disabled") === "true";
            if (element.disabled || ariaDisabled) return false;
            const rect = element.getBoundingClientRect();
            const x = rect.x + rect.width / 2;
            const y = rect.y + rect.height / 2;
            const top = document.elementFromPoint(x, y);
            return top === element || element.contains(top) || top.contains(element);
        }})()"#,
        json_string(selector)
    );
    page.evaluate_value(&expression)
        .await
        .map(|value| value == serde_json::Value::Bool(true))
        .unwrap_or(false)
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}
