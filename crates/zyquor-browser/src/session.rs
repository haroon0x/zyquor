//! Session management: connect to a CDP Chrome, decide which page each flow
//! needs, and dismiss `beforeunload` dialogs. Ported from
//! `openPersistentContext` / `pageFor*` / `existingXPage` /
//! `installDialogDismissers` in `packages/browser/src/index.ts`.
//!
//! The `ownsContext` concept collapses: connections don't own the Browser
//! context (it already exists inside Chrome), so "closing" a session only
//! ever closes pages this code created.

use std::sync::Arc;

use chromiumoxide::cdp::browser_protocol::page::EventJavascriptDialogOpening;
use futures::stream::StreamExt;

use crate::page::CdpPage;

/// One CDP connection to a dedicated-profile Chrome.
#[derive(Debug)]
pub struct Session {
    browser: Arc<chromiumoxide::browser::Browser>,
    owned: Arc<std::sync::Mutex<Vec<chromiumoxide::Page>>>,
}

impl Session {
    /// Connect to the Chrome answering at `cdp_url`. No auto-launch: the
    /// launcher owns spawning; callers `ensure_browser_cdp` first.
    pub async fn connect(cdp_url: &str) -> Result<Self, String> {
        let (browser, _handler) = chromiumoxide::browser::Browser::connect(cdp_url)
            .await
            .map_err(|error| error.to_string())?;
        Ok(Self {
            browser: Arc::new(browser),
            owned: Arc::new(std::sync::Mutex::new(Vec::new())),
        })
    }

    /// Spawn a fresh tab; it is registered as owned by this session and
    /// closed when the session ends.
    pub async fn new_page(&self) -> Result<CdpPage, String> {
        let page = self.new_page_owned().await?;
        Ok(CdpPage::new(page))
    }

    async fn new_page_owned(&self) -> Result<chromiumoxide::Page, String> {
        let page = self
            .browser
            .new_page("about:blank")
            .await
            .map_err(|error| error.to_string())?;
        self.install_dialog_dismissers(&page);
        if let Ok(mut owned) = self.owned.lock() {
            owned.push(page.clone());
        }
        Ok(page)
    }

    /// The first open page, or a new tab (TS `context.pages()[0] ?? context.newPage()`).
    pub async fn first_page_or_new(&self) -> Result<chromiumoxide::Page, String> {
        let pages = self.pages().await?;
        if let Some(page) = pages.into_iter().next() {
            return Ok(page);
        }
        self.new_page_owned().await
    }

    /// The pages currently open in this browser.
    pub async fn pages(&self) -> Result<Vec<chromiumoxide::Page>, String> {
        self.browser
            .pages()
            .await
            .map_err(|error| error.to_string())
    }

    /// `existingXPage` — prefer the compose tab, else the first X tab.
    pub async fn existing_x_page(&self) -> Result<Option<chromiumoxide::Page>, String> {
        let pages = self.pages().await?;
        let mut x_pages: Vec<chromiumoxide::Page> = Vec::new();
        for page in pages {
            let url = page_url(&page).await;
            if url.starts_with("https://x.com/") || url.starts_with("https://twitter.com/") {
                x_pages.push(page);
            }
        }
        for page in &x_pages {
            if page_url(page).await.starts_with("https://x.com/compose") {
                return Ok(Some(page.clone()));
            }
        }
        Ok(x_pages.into_iter().next())
    }

    /// Close only the tabs this session created.
    pub async fn close_owned_pages(&self) {
        let pages = self
            .owned
            .lock()
            .map(|mut owned| owned.drain(..).collect::<Vec<_>>())
            .unwrap_or_default();
        for page in pages {
            let _ = page.close().await;
        }
    }

    pub fn install_dialog_dismissers(&self, page: &chromiumoxide::Page) {
        let page = page.clone();
        self.spawn_dialog_dismisser(page);
    }

    fn spawn_dialog_dismisser(&self, page: chromiumoxide::Page) {
        tokio::spawn(async move {
            let mut stream = match page.event_listener::<EventJavascriptDialogOpening>().await {
                Ok(stream) => stream,
                Err(_) => return,
            };
            while stream.next().await.is_some() {
                // `page.handleJavaScriptDialog` — accept, best-effort.
                let params = chromiumoxide::cdp::browser_protocol::page::HandleJavaScriptDialogParams::builder()
                    .accept(true)
                    .build();
                if let Ok(params) = params {
                    let _ = page.execute(params).await;
                }
            }
        });
    }
}

pub async fn page_url(page: &chromiumoxide::Page) -> String {
    page.url().await.ok().flatten().unwrap_or_default()
}

/// Close duplicate X tabs, keeping the compose tab (`closeDuplicateXPages`).
pub async fn close_duplicate_x_pages(session: &Session) -> Result<(), String> {
    let pages = session.pages().await?;
    let mut x_pages: Vec<chromiumoxide::Page> = Vec::new();
    for page in pages {
        let url = page_url(&page).await;
        if url.starts_with("https://x.com/") || url.starts_with("https://twitter.com/") {
            x_pages.push(page);
        }
    }
    if x_pages.len() <= 1 {
        return Ok(());
    }
    let mut keep_url: Option<String> = None;
    for page in &x_pages {
        if page_url(page).await.starts_with("https://x.com/compose") {
            keep_url = Some(page_url(page).await);
            break;
        }
    }
    if keep_url.is_none() {
        keep_url = Some(page_url(x_pages.first().unwrap_or(&x_pages[0])).await);
    }
    let keep_url = keep_url.unwrap_or_default();
    for page in x_pages {
        if page_url(&page).await != keep_url {
            let _ = page.close().await;
        }
    }
    Ok(())
}
