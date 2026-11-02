//! Prints post-gate and lifecycle results for the parity script.
//!
//! Run: `cargo run -p zyquor-core --example parity`

use zyquor_core::spacing::{PostGateInput, evaluate_post_gate};
use zyquor_core::types::{DraftStatus, PostJobStatus};
use zyquor_core::{can_transition_draft, can_transition_post_job};

fn main() {
    let cases: [(&str, Option<&str>, Option<f64>, &str); 7] = [
        (
            "2026-01-01T12:10:00.000Z",
            Some("2026-01-01T12:00:00.000Z"),
            Some(30.0),
            "30",
        ),
        (
            "2026-01-01T12:31:00.000Z",
            Some("2026-01-01T12:00:00.000Z"),
            Some(30.0),
            "30",
        ),
        ("2026-01-01T12:00:00.000Z", None, Some(30.0), "30"),
        (
            "2026-01-01T12:00:00.000Z",
            Some("garbage"),
            Some(30.0),
            "30",
        ),
        (
            "2026-01-01T12:00:00.000Z",
            Some("2026-01-01T12:00:00.000Z"),
            Some(1.0),
            "1",
        ),
        (
            "2026-01-01T12:00:00.000Z",
            Some("2026-01-01T11:50:00.000Z"),
            None,
            "NaN",
        ),
        (
            "2026-03-04T05:06:07.123Z",
            Some("2026-03-04T04:36:07.123Z"),
            Some(22.5),
            "22.5",
        ),
    ];

    for (now, last, gap, gap_label) in cases {
        let Ok(result) = evaluate_post_gate(&PostGateInput {
            gap_min_minutes: gap,
            last_posted_at: last.map(str::to_string),
            now: now.to_string(),
            trace_id: None,
        }) else {
            println!("GATE|{now}|ERROR");
            continue;
        };

        println!(
            "GATE|{now}|{}|{gap_label}|{}|{}|{}|{}|{}",
            last.unwrap_or("null"),
            result.allowed,
            result.next_eligible_at.as_deref().unwrap_or("null"),
            result.reason,
            result.required_gap_minutes,
            result.wait_minutes,
        );
    }

    for from in DraftStatus::ALL {
        for to in DraftStatus::ALL {
            println!(
                "DRAFT|{}|{}|{}",
                from.as_str(),
                to.as_str(),
                can_transition_draft(*from, *to)
            );
        }
    }

    for from in PostJobStatus::ALL {
        for to in PostJobStatus::ALL {
            println!(
                "JOB|{}|{}|{}",
                from.as_str(),
                to.as_str(),
                can_transition_post_job(*from, *to)
            );
        }
    }
}
