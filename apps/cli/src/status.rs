//! `zyquor status` — one-shot health + state summary for agents and humans.
//!
//! Reads `/system/status` (plus `/health`) from the local API and prints either
//! a compact human summary or the raw JSON (`--json`), so an agent harness can
//! discover the running app with a single command.

use serde_json::{Value, json};

use crate::cli;

fn wants_json(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--json")
}

pub async fn run(args: &[String]) -> Result<i32, String> {
    let api_url = cli::resolve_api_url().await;
    let http = cli::http(&api_url);
    let health = http.get_json("/health", 5_000).await;
    let status = http.get_json("/system/status", 10_000).await;

    let errors: Vec<String> = [health.as_ref().err(), status.as_ref().err()]
        .into_iter()
        .flatten()
        .cloned()
        .collect();
    let payload = json!({
        "apiUrl": api_url,
        "ok": health.is_ok() && status.is_ok(),
        "health": health.as_ref().ok(),
        "status": status.as_ref().ok(),
        "errors": errors
    });

    if wants_json(args) {
        println!(
            "{}",
            serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string())
        );
        return Ok(if payload["ok"].as_bool() == Some(true) {
            0
        } else {
            1
        });
    }

    if let Err(error) = &status {
        println!("Zyquor is not reachable at {api_url}");
        println!("  error: {error}");
        println!("Start it with: cargo run -p zyquor-cli -- start");
        return Ok(1);
    }
    let status: &Value = status.as_ref().ok().unwrap_or(&Value::Null);
    let worker_running = status.pointer("/worker/running").and_then(Value::as_bool);
    let worker_paused = status.pointer("/worker/paused").and_then(Value::as_bool);
    let posting = status.pointer("/posting");
    let generation = status.pointer("/generation");
    let counts = status.pointer("/counts");
    println!(
        "Zyquor  api={api_url}  worker={}  post={}  prepare={}  model={}/{}",
        match (worker_running, worker_paused) {
            (_, Some(true)) => "paused",
            (Some(true), _) => "running",
            _ => "stopped",
        },
        flag(posting.and_then(|value| value.get("enablePost"))),
        flag(posting.and_then(|value| value.get("enablePrepare"))),
        generation
            .and_then(|value| value.get("provider"))
            .and_then(Value::as_str)
            .unwrap_or("?"),
        generation
            .and_then(|value| value.get("model"))
            .and_then(Value::as_str)
            .unwrap_or("?"),
    );
    if let Some(counts) = counts {
        println!(
            "queue  drafts={}  jobs={}  sourcePackets={}  ingestConfigs={}",
            count(counts, "drafts"),
            count(counts, "jobs"),
            count(counts, "sourcePackets"),
            count(counts, "ingestConfigsEnabled"),
        );
        if let Some(by_status) = counts.get("jobsByStatus").and_then(Value::as_object) {
            let mut parts: Vec<String> = by_status
                .iter()
                .map(|(status, count)| format!("{status}={}", count.as_u64().unwrap_or_default()))
                .collect();
            parts.sort();
            if !parts.is_empty() {
                println!("jobs   {}", parts.join("  "));
            }
        }
    }
    if let Some(heartbeat) = status
        .pointer("/worker/lastHeartbeatAt")
        .and_then(Value::as_str)
    {
        println!("worker last heartbeat: {heartbeat}");
    }
    Ok(0)
}

fn flag(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_bool) {
        Some(true) => "on",
        Some(false) => "off",
        None => "?",
    }
}

fn count(counts: &Value, key: &str) -> u64 {
    counts.get(key).and_then(Value::as_u64).unwrap_or_default()
}
