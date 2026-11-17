//! `zyquor prompt` — print the exact prompt the writer model receives.
//!
//! This is the inspection surface for Zyquor's writing codex: no provider call,
//! no browser, no side effects. Useful for tuning the codex, debugging an odd
//! draft, or letting an agent review the contract before approving one.

use serde_json::json;
use zyquor_generation::prompts::{system_prompt, user_prompt};
use zyquor_generation::types::{GenerateDraftCandidatesInput, ReplyContext};

#[derive(Default)]
struct Options {
    idea: String,
    tweet_type: Option<String>,
    count: Option<usize>,
    reply_to: Option<String>,
    reply_text: Option<String>,
    tone: Option<String>,
    objective: Option<String>,
    json: bool,
    system_only: bool,
    user_only: bool,
}

fn parse(args: &[String]) -> Result<Options, String> {
    let mut options = Options::default();
    let mut index = 0;
    while index < args.len() {
        let flag = args[index].as_str();
        let value = |index: usize| -> Result<&String, String> {
            args.get(index + 1)
                .ok_or_else(|| format!("missing value for {flag}"))
        };
        match flag {
            "--json" => options.json = true,
            "--system-only" => options.system_only = true,
            "--user-only" => options.user_only = true,
            "--idea" => {
                options.idea = value(index)?.clone();
                index += 1;
            }
            "--tweet-type" => {
                options.tweet_type = Some(value(index)?.clone());
                index += 1;
            }
            "--reply-to" => {
                options.reply_to = Some(value(index)?.clone());
                index += 1;
            }
            "--reply-text" => {
                options.reply_text = Some(value(index)?.clone());
                index += 1;
            }
            "--tone" => {
                options.tone = Some(value(index)?.clone());
                index += 1;
            }
            "--objective" => {
                options.objective = Some(value(index)?.clone());
                index += 1;
            }
            "--count" => {
                let raw = value(index)?;
                let parsed = raw
                    .parse::<usize>()
                    .map_err(|_| format!("invalid --count: {raw}"))?;
                options.count = Some(parsed.clamp(1, 50));
                index += 1;
            }
            other => return Err(format!("unknown prompt flag: {other}")),
        }
        index += 1;
    }
    if options.idea.trim().is_empty() {
        return Err("--idea is required".to_string());
    }
    Ok(options)
}

fn handle_from_url(url: &str) -> String {
    url.split('/')
        .nth(3)
        .filter(|segment| !segment.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

fn build_input(options: &Options) -> GenerateDraftCandidatesInput {
    let tweet_type = if options.reply_to.is_some() {
        Some("reply".to_string())
    } else {
        options.tweet_type.clone()
    };
    GenerateDraftCandidatesInput {
        idea: options.idea.clone(),
        count: options.count,
        tweet_type,
        tone: options.tone.clone(),
        objective: options.objective.clone(),
        reply_context: options.reply_to.as_ref().map(|url| ReplyContext {
            author_handle: handle_from_url(url),
            url: url.clone(),
            text: options.reply_text.clone(),
            ..ReplyContext::default()
        }),
        ..GenerateDraftCandidatesInput::default()
    }
}

pub fn run(args: &[String]) -> Result<i32, String> {
    let options = parse(args)?;
    let input = build_input(&options);
    let system = system_prompt(&input);
    let user = user_prompt(&input);
    let combined = format!("{system}\n\n{user}");

    if options.json {
        let value = json!({
            "system": system,
            "user": user,
            "combined": combined,
            "systemChars": system.chars().count(),
            "userChars": user.chars().count(),
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string())
        );
        return Ok(0);
    }

    if !options.user_only {
        println!("=== SYSTEM PROMPT ({} chars) ===", system.chars().count());
        println!("{system}");
    }
    if !options.system_only {
        if !options.user_only {
            println!();
        }
        println!("=== USER PROMPT ({} chars) ===", user.chars().count());
        println!("{user}");
    }
    Ok(0)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn requires_an_idea() {
        assert!(parse(&args(&[])).is_err());
        assert!(parse(&args(&["--idea", "  "])).is_err());
    }

    #[test]
    fn parses_value_flags_and_reply_lane() {
        let options = parse(&args(&[
            "--idea",
            "target text",
            "--reply-to",
            "https://x.com/someone/status/1",
            "--reply-text",
            "the claim",
            "--count",
            "7",
        ]))
        .unwrap();
        assert_eq!(options.count, Some(7));
        assert_eq!(handle_from_url("https://x.com/someone/status/1"), "someone");
        let input = build_input(&options);
        assert_eq!(input.tweet_type.as_deref(), Some("reply"));
        assert_eq!(input.reply_context.unwrap().author_handle, "someone");
    }

    #[test]
    fn rejects_unknown_flags_and_bad_counts() {
        assert!(parse(&args(&["--idea", "x", "--nope"])).is_err());
        assert!(parse(&args(&["--idea", "x", "--count", "many"])).is_err());
    }
}
