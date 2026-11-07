//! Browser automation over CDP against dedicated Chrome profiles, ported from
//! `packages/browser/src/index.ts` (Playwright via `playwright-core`).
//!
//! Rules carried over unchanged from the TypeScript tree (see CLAUDE.md):
//! - Dedicated profiles only, under `profiles/` — never the everyday Chrome
//!   profile (the account layer validates the directory before entering).
//! - No stealth, anti-detection, proxy rotation, or CAPTCHA bypass.
//! - No automated follows, likes, reposts, DMs, or engagement loops.
//! - The final Post click stays explicit, gated by the API-layer env flags,
//!   and logged (this crate reports click results; callers gate them).
//! - Failed post attempts are never auto-retried.
//!
//! Deep modules:
//! - `launch_state` owns `posting-chrome.json`.
//! - `launcher` owns Chrome processes (binary resolution, spawn args,
//!   readiness wait, detached PID bookkeeping).
//! - `session` owns the CDP connection and page selection heuristics
//!   (existing tab preference, owned tab cleanup, dialog dismissal).
//! - `page` owns the Playwright-primitive reimplementation (visible waits,
//!   actionability gates, scroll-into-view + hit-test clicks, text
//!   insertion via `Input.insertText`).
//! - `login` owns login detection + handle resolution.
//! - `feed` owns the read flows (home feed, mentions, timeline, tweet,
//!   performance metrics) and their scroll-and-collect machinery.
//! - `composer` owns the post flow (open → type → verify → optional click
//!   → verify permalink). The submit click only ever happens when the
//!   caller sets `submit`; the env gate around posting lives in the
//!   API/worker layer.
//! - `delete_post` owns the delete-own-post flow.
//! - `tracing` owns the trace-artifact capture.
//! - `artifacts` owns the failure-artifact file layout.
//!
//! Verified separately of the flows: `launch_state`, `parse_utils`,
//! `fetched_types` helpers. The browser flows themselves require a route
//! should only ever hit real browsers and live X pages.

pub mod artifacts;
pub mod composer;
pub mod delete_post;
pub mod feed;
pub mod fetched_types;
pub mod launch_state;
pub mod launcher;
pub mod login;
pub mod page;
pub mod parse_utils;
pub mod session;
pub mod tracing;

pub use composer::{BrowserPrepareError, PreparePostInput, PreparePostResult, prepare_post};
pub use delete_post::{BrowserDeleteError, DeletePostInput, DeletePostResult, delete_post};
pub use feed::{
    FeedFetchInput, FetchHomeFeedResult, FetchTweetPerformanceInput, FetchTweetPerformanceResult,
    FetchTweetResult, fetch_account_timeline, fetch_tweet, fetch_tweet_performance,
    fetch_x_home_feed, fetch_x_mentions,
};
pub use fetched_types::{TweetPerformanceMetrics, XFeedTweet};
pub use launch_state::{CdpLaunchState, read_cdp_launch_state, read_cdp_launch_state_for};
pub use launcher::{close_browser_cdp, ensure_browser_cdp, find_chrome_executable};
pub use login::{CheckXLoginResult, check_x_login, read_logged_in_handle};
pub use page::CdpPage;
pub use session::Session;
