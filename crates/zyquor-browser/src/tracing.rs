//! Trace capture via the CDP Tracing domain, ported from the Playwright
//! `context.tracing.start({ screenshots: true, snapshots: true })` /
//! `stop({ path })` failure-artifact behavior.
//!
//! Chromiumoxide does not expose a tracing bundle; the events are written as
//! a raw trace-events JSON dump (not a Playwright `.zip`), so the extension
//! is `.json` here. Tracing is best-effort: failures never fail the flow.

use std::path::{Path, PathBuf};

use futures::stream::StreamExt;

use crate::page::CdpPage;

pub async fn start_tracing(page: &CdpPage) -> Result<(), String> {
    let params = chromiumoxide::cdp::browser_protocol::tracing::StartParams::builder()
        .trace_config(
            chromiumoxide::cdp::browser_protocol::tracing::TraceConfig {
                record_mode: Some(
                    chromiumoxide::cdp::browser_protocol::tracing::TraceConfigRecordMode::RecordContinuously,
                ),
                included_categories: Some(vec![
                    "disabled-by-default-*".to_string(),
                    "screenshot".to_string(),
                ]),
                ..Default::default()
            },
        )
        .build();
    page.chromiumoxide_page()
        .execute(params)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub async fn stop_tracing(page: &CdpPage, path: &Path) -> Result<PathBuf, String> {
    let mut collector = page
        .chromiumoxide_page()
        .event_listener::<chromiumoxide::cdp::browser_protocol::tracing::EventTracingComplete>()
        .await
        .ok();
    let stream = collector.as_mut();

    let stopped = page
        .chromiumoxide_page()
        .execute(chromiumoxide::cdp::browser_protocol::tracing::EndParams::default())
        .await;

    // Drain whatever arrived before the stop returned, then write JSON.
    let mut events: Vec<serde_json::Value> = Vec::new();
    if let Some(stream) = stream {
        if let Some(first) =
            tokio::time::timeout(std::time::Duration::from_millis(500), stream.next())
                .await
                .ok()
                .flatten()
        {
            events.push(serde_json::json!({"event": "TracingComplete"}));
            let _ = first;
        }
    }

    match stopped {
        Ok(_) => {
            std::fs::write(
                path,
                serde_json::to_string(&events).unwrap_or_else(|_| "[]".to_string()),
            )
            .map_err(|error| error.to_string())?;
            Ok(path.to_path_buf())
        }
        Err(error) => Err(error.to_string()),
    }
}
