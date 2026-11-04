//! Scores each stdin line with the Rust quality port and prints JSON.
//!
//! Run: `cargo run -q -p zyquor-generation --example quality_parity < cases.txt`

use std::io::{self, BufRead};

use zyquor_generation::{
    format_tweet_text, is_clean_tweet_text, is_interrogation_dodge_reply, post_process_tweet_text,
    score_tweet_quality,
};

fn main() {
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(input) = line else { continue };
        if input.trim().is_empty() {
            continue;
        }
        let payload = serde_json::json!({
            "input": input,
            "score": score_tweet_quality(&input),
            "clean": is_clean_tweet_text(&input),
            "dodge": is_interrogation_dodge_reply(&input),
            "formatted": format_tweet_text(&input),
            "postProcessed": post_process_tweet_text(&input),
        });
        println!("{payload}");
    }
}
