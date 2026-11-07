//! `zyquor tweet-eval` — evaluate generated posts against the editorial bar.
//!
//! Port of `scripts/tweet-eval.mjs`: five fixed cases, three candidates per
//! case, heuristic scoring with `zyquor_generation::quality`, and an
//! independent judge pass shelling out to the `command-code` CLI. Prints the
//! summary JSON and exits non-zero unless everything passes.

use std::io::Write;
use std::process::{Command, Stdio};

use zyquor_generation::types::GenerateDraftCandidatesInput;
use zyquor_generation::{
    DraftGenerationProvider, ReqwestFetch, create_generation_provider_from_env,
    is_clean_tweet_text, passes_tweet_quality_floor, quality_minimum,
    resolve_generation_provider_config, score_tweet_quality,
};

const JUDGE_RUBRIC: &str = "You are an independent judge grading public X posts against a high editorial bar. Judge each post only against the input context shown with it. Do not add facts from memory. For each numbered post return JSON only:\n{\"posts\":[{\"n\":1,\"score\":7,\"verdict\":\"strong|ok|weak\",\"fault\":\"one short phrase\",\"fix\":\"one short instruction\"}]}\nScore 1-10 on: does it carry one useful thought rather than a source recap, is the anchor concrete, is the payoff supported by the input, does it read like a person rather than a model, and is the opener earned. 8-10 means you would post it from your own account. 5-7 means it needs revision. 1-4 means it should be rejected. Be strict: a fluent recap or unsupported claim is a 4 or lower.";

#[derive(Debug)]
struct Case {
    name: &'static str,
    tweet_type: &'static str,
    idea: &'static str,
}

const CASES: &[Case] = &[
    Case {
        name: "arxiv-replay",
        tweet_type: "useful_info",
        idea: "Title: Deterministic Replay for AI Agent Systems\nURL: https://arxiv.org/abs/2607.16200\nSummary: agent systems that couple LLMs with external tools are non-deterministic because of LLM sampling variance, external API state, CDN infrastructure headers, and execution-environment noise.\nFacts:\n- existing observability platforms capture execution logs but cannot reproduce a run in isolation\n- agrepl is a developer-first CLI framework for deterministic replay",
    },
    Case {
        name: "show-hn-index",
        tweet_type: "useful_info",
        idea: "Title: Show HN: Ex Situ, open-source spatial index of displaced cultural artifacts\nURL: https://exsitu.app/map\nSummary: a spatial index that maps museum artefacts as arcs from origin site to holding institution.\nFacts:\n- AGPL-3.0, Next.js + Deck.gl frontend, Strapi backend, Python ETL over museum open-access APIs\n- indexes over 100k artifacts across 8 collections including the Met, V&A, SMB Berlin\n- started as an MA thesis in 2022, built mostly solo",
    },
    Case {
        name: "release-note",
        tweet_type: "feed_observation",
        idea: "Title: Zed 1.0 released\nSummary: the editor reached a stable release after years of work on collaboration, speed, and native performance.\nFacts:\n- 1.0 is the first stable release\n- focus areas were collaboration, speed, native performance",
    },
    Case {
        name: "ops-lesson",
        tweet_type: "guide",
        idea: "We moved a low-traffic internal service off Kubernetes onto a single Docker host. Facts: the service does not need autoscaling, multi-region routing, or fast node replacement; the migration removed cluster upgrades, RBAC config, and scheduler debugging from the on-call load.",
    },
    Case {
        name: "tool-note",
        tweet_type: "useful_info",
        idea: "ripgrep is used for repository-wide text search. Facts: it searches large repositories quickly; it matches text, not symbols, so it cannot distinguish a definition from a mention.",
    },
];

fn env_lookup(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn judge_verdict(score: i64) -> &'static str {
    if score >= 8 {
        "strong"
    } else if score >= 5 {
        "ok"
    } else {
        "weak"
    }
}

/// Parse the judge's JSON envelope, mirroring `parseJudge` in the TS script.
pub fn parse_judge(raw: &str, max: usize) -> Vec<(usize, i64, String, String, String)> {
    let Some(start) = raw.find('{') else {
        return Vec::new();
    };
    let Some(end) = raw.rfind('}') else {
        return Vec::new();
    };
    if end <= start {
        return Vec::new();
    }
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw[start..=end]) else {
        return Vec::new();
    };
    let Some(posts) = parsed.get("posts").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut seen: Vec<usize> = Vec::new();
    let mut out = Vec::new();
    for post in posts {
        let n = post
            .get("n")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0);
        let score = post.get("score").and_then(serde_json::Value::as_i64);
        let Some(score) = score else {
            continue;
        };
        if n < 1 || n as usize > max || seen.contains(&(n as usize)) {
            continue;
        }
        seen.push(n as usize);
        let normalized = score.clamp(1, 10);
        let fault = post
            .get("fault")
            .and_then(serde_json::Value::as_str)
            .map(|v| v.trim().chars().take(160).collect())
            .unwrap_or_default();
        let fix = post
            .get("fix")
            .and_then(serde_json::Value::as_str)
            .map(|v| v.trim().chars().take(160).collect())
            .unwrap_or_default();
        out.push((
            n as usize,
            normalized,
            judge_verdict(normalized).to_string(),
            fault,
            fix,
        ));
    }
    out
}

fn run_command_code(prompt: &str, model: &str) -> Result<String, String> {
    let path =
        std::env::var("ZYQUOR_COMMAND_CODE_PATH").unwrap_or_else(|_| "command-code".to_string());
    let mut child = Command::new(&path)
        .args([
            "--skip-onboarding",
            "--permission-mode",
            "plan",
            "--model",
            model,
            "--print",
        ])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let output = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr)
            .trim()
            .chars()
            .take(500)
            .collect())
    }
}

pub async fn run() -> Result<i32, String> {
    let config = resolve_generation_provider_config(&env_lookup)
        .map_err(|error| format!("generation config failed: {error}"))?;
    let fetch = ReqwestFetch::new();
    let provider = create_generation_provider_from_env(&env_lookup, fetch)
        .map_err(|error| error.message.clone())?;
    let quality_min = quality_minimum(&env_lookup);
    let rounds: usize = std::env::var("ZYQUOR_EVAL_ROUNDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);

    #[derive(Debug)]
    struct Generated {
        item: &'static Case,
        candidates: Vec<zyquor_generation::types::GeneratedDraftCandidate>,
        error: Option<String>,
        round: usize,
    }
    let mut results: Vec<Generated> = Vec::new();
    for round in 1..=rounds {
        for item in CASES {
            let input = GenerateDraftCandidatesInput {
                idea: item.idea.to_string(),
                count: Some(3),
                tweet_type: Some(item.tweet_type.to_string()),
                ..GenerateDraftCandidatesInput::default()
            };
            match provider.generate_draft_candidates(&input).await {
                Ok(candidates) => results.push(Generated {
                    item,
                    candidates,
                    error: None,
                    round,
                }),
                Err(error) => results.push(Generated {
                    item,
                    candidates: Vec::new(),
                    error: Some(error.message.clone()),
                    round,
                }),
            }
        }
    }

    #[derive(Debug)]
    struct Row {
        case: String,
        error: Option<String>,
        round: usize,
        model_rank: Option<usize>,
        text: Option<String>,
        clean: bool,
        heuristic: i64,
        passes_floor: bool,
        judge: Option<i64>,
        verdict: Option<String>,
        fault: Option<String>,
        fix: Option<String>,
    }
    let mut rows: Vec<Row> = Vec::new();
    for generated in &results {
        if let Some(error) = &generated.error {
            rows.push(Row {
                case: generated.item.name.to_string(),
                error: Some(error.clone()),
                round: generated.round,
                model_rank: None,
                text: None,
                clean: false,
                heuristic: 0,
                passes_floor: false,
                judge: None,
                verdict: None,
                fault: None,
                fix: None,
            });
            continue;
        }
        for candidate in &generated.candidates {
            let heuristic = score_tweet_quality(&candidate.text);
            rows.push(Row {
                case: generated.item.name.to_string(),
                error: None,
                round: generated.round,
                model_rank: Some(candidate.rank),
                text: Some(candidate.text.clone()),
                clean: is_clean_tweet_text(&candidate.text),
                heuristic,
                passes_floor: passes_tweet_quality_floor(&candidate.text, quality_min),
                judge: None,
                verdict: None,
                fault: None,
                fix: None,
            });
        }
    }

    let judged_indices: Vec<usize> = rows
        .iter()
        .enumerate()
        .filter(|(_, row)| row.text.is_some())
        .map(|(index, _)| index)
        .collect();
    let mut judge_error: Option<String> = None;
    if !judged_indices.is_empty() {
        let listing = judged_indices
            .iter()
            .enumerate()
            .map(|(index, row_index)| {
                let row = &rows[*row_index];
                let item = CASES.iter().find(|item| item.name == row.case);
                let round_label = if rounds > 1 {
                    format!(" [round {}]", row.round)
                } else {
                    String::new()
                };
                format!(
                    "{}. Case: {}{round_label}\nInput context:\n{}\nPost:\n{}",
                    index + 1,
                    row.case,
                    item.map(|item| item.idea).unwrap_or(""),
                    row.text.as_deref().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let model = std::env::var("ZYQUOR_COMMAND_CODE_MODEL")
            .unwrap_or_else(|_| "gpt-5.6-luna".to_string());
        match run_command_code(&format!("{JUDGE_RUBRIC}\n\nPosts:\n{listing}"), &model) {
            Ok(raw) => {
                for (n, score, verdict, fault, fix) in parse_judge(&raw, judged_indices.len()) {
                    if let Some(row_index) = judged_indices.get(n - 1) {
                        let row = &mut rows[*row_index];
                        row.judge = Some(score);
                        row.verdict = Some(verdict);
                        row.fault = if fault.is_empty() { None } else { Some(fault) };
                        row.fix = if fix.is_empty() { None } else { Some(fix) };
                    }
                }
            }
            Err(error) => judge_error = Some(error.chars().take(500).collect()),
        }
    }

    let judged_rows: Vec<&Row> = rows.iter().filter(|row| row.text.is_some()).collect();
    let scored: Vec<i64> = rows.iter().filter_map(|row| row.judge).collect();
    let mean_judge = if scored.is_empty() {
        None
    } else {
        Some(scored.iter().sum::<i64>() as f64 / scored.len() as f64)
    };
    let mean_heuristic = if judged_rows.is_empty() {
        None
    } else {
        Some(
            judged_rows.iter().map(|row| row.heuristic).sum::<i64>() as f64
                / judged_rows.len() as f64,
        )
    };
    let local_passes = judged_rows.iter().filter(|row| row.passes_floor).count();
    let judge_coverage = if judged_rows.is_empty() {
        0.0
    } else {
        scored.len() as f64 / judged_rows.len() as f64
    };
    let local_pass_rate = if judged_rows.is_empty() {
        0.0
    } else {
        local_passes as f64 / judged_rows.len() as f64
    };
    let generation_failures = rows.iter().filter(|row| row.error.is_some()).count();
    let ok = generation_failures == 0
        && judge_error.is_none()
        && judge_coverage == 1.0
        && local_pass_rate == 1.0;

    let row_values: Vec<serde_json::Value> = rows
        .iter()
        .map(|row| {
            let mut value = serde_json::Map::new();
            value.insert("case".into(), row.case.clone().into());
            if let Some(error) = &row.error {
                value.insert("error".into(), error.clone().into());
            }
            value.insert("round".into(), row.round.into());
            value.insert(
                "modelRank".into(),
                serde_json::to_value(row.model_rank).unwrap_or(serde_json::Value::Null),
            );
            value.insert(
                "text".into(),
                serde_json::to_value(row.text.clone()).unwrap_or(serde_json::Value::Null),
            );
            value.insert("clean".into(), row.clean.into());
            value.insert("heuristic".into(), row.heuristic.into());
            value.insert("passesFloor".into(), row.passes_floor.into());
            if let Some(judge) = row.judge {
                value.insert("judge".into(), judge.into());
            }
            if let Some(verdict) = &row.verdict {
                value.insert("verdict".into(), verdict.clone().into());
            }
            if let Some(fault) = &row.fault {
                value.insert("fault".into(), fault.clone().into());
            }
            if let Some(fix) = &row.fix {
                value.insert("fix".into(), fix.clone().into());
            }
            serde_json::Value::Object(value)
        })
        .collect();

    let value = serde_json::json!({
        "ok": ok,
        "generation": config,
        "qualityMinimum": quality_min,
        "generationFailures": generation_failures,
        "judgeError": judge_error,
        "judgeCoverage": judge_coverage,
        "localPassRate": local_pass_rate,
        "meanJudgeScore": mean_judge,
        "meanHeuristicScore": mean_heuristic,
        "rows": row_values,
    });
    println!(
        "{}",
        serde_json::to_string_pretty(&value).unwrap_or_default()
    );
    if ok { Ok(0) } else { Ok(1) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verdict_bands() {
        assert_eq!(judge_verdict(9), "strong");
        assert_eq!(judge_verdict(6), "ok");
        assert_eq!(judge_verdict(2), "weak");
    }

    #[test]
    fn parses_judge_envelope() {
        let raw = "noise {\"posts\":[{\"n\":1,\"score\":7,\"verdict\":\"ok\"},{\"n\":2,\"score\":99,\"fault\":\"x\",\"fix\":\"y\"}]} tail";
        let parsed = parse_judge(raw, 2);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].1, 10);
    }
}
