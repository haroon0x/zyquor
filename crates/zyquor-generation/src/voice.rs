//! Writing codex: the shared craft contract used by both prompt assembly and
//! the deterministic quality gate.
//!
//! The rules are distilled from five public writing skills, rewritten for a
//! short-form X post and for replies rather than copied:
//!
//! - `petergyang/no-ai-slop` (MIT): binary contrasts, throat-clearing,
//!   faux-insight setups, colon reveals, importance puffery, weasel
//!   attribution, dramatic fragments, recap endings.
//! - `addyosmani/clarity` (MIT): preserve truth and ownership, one reader and
//!   one job, fix substance before surface, the portability test, don't
//!   manufacture humanness.
//! - `conorbronsdon/avoid-ai-writing` (MIT): signals not proof; protected
//!   facts; formula carrying the argument (flatten test / relation test);
//!   inflation without mechanism; word tiers.
//! - `blader/humanizer` (MIT): staging, rhythm-by-rule, inflation,
//!   formatting-by-rule, leftovers, wrong reader; keep the details that carry
//!   the writer's voice.
//! - `mblode/agent-skills` ghostwriter (MIT): shortest true version; machine
//!   tells; noun stacks; abstract actors; performed cleverness; preserve the
//!   profile's own habits instead of manufacturing quirks.
//!
//! The goal is *better writing*, not beating an AI detector: the gate exists
//! because these structures are usually the model padding instead of saying
//! something. A human may ship a contrast or a dash on purpose; only the
//! highest-confidence structures are hard failures.

use fancy_regex::Regex;

/// Which lane a piece of text belongs to. Replies have different obligations
/// (react to the author, don't re-explain the thread) than standalone posts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    Post,
    Reply,
}

impl Lane {
    pub fn from_tweet_type(tweet_type: Option<&str>) -> Self {
        if tweet_type == Some("reply") {
            Lane::Reply
        } else {
            Lane::Post
        }
    }
}

// ---------------------------------------------------------------------------
// Prompt-side codex
// ---------------------------------------------------------------------------

/// Shared craft rules, injected into every generation prompt.
///
/// Written as instructions to the writer model. Each rule is checkable against
/// the output; none of them add a fact to the material.
pub const CORE_CODEX: &str = "\
Write for one specific reader. Every sentence must add something that reader did not already have: a fact, a mechanism, a consequence, a distinction, a decision rule, or an honest limit.

Say the thing. Lead with the claim, the result, or the decision. No throat-clearing (\"here's the thing\", \"let me be clear\"), no faux-insight setups (\"what nobody tells you\", \"the part everyone misses\"), no rhetorical-question openers, no \"imagine\"/\"picture this\" staging. State the positive claim: no \"not X, it's Y\" or \"isn't just X, it's Y\" skeletons. Use a contrast only when the reader actually holds the wrong side, and then name both sides plainly.

Be concrete or be quiet. Names, numbers, dates, mechanisms, and consequences beat abstractions. Apply the portability test: if a sentence could move unchanged into someone else's post about another subject, cut it or replace it with a specific the material supports. Never invent a specific to pass the test.

Make the verb do the work. Active voice; use \"is\" and \"has\" instead of \"serves as\", \"stands as\", or \"boasts\". Name the actor: decisions do not decide, data does not speak. Cut trailing \"-ing\" explanations (\"highlighting\", \"underscoring\", \"reflecting\") that claim significance instead of showing it.

Do not inflate. No \"pivotal\", \"testament to\", \"marks a turning point\", \"underscores the importance\", \"sets the stage\". No borrowed authority (\"experts agree\", \"studies show\", \"many argue\") unless the material names the source. No sales language: no unlock, supercharge, game-changer, 10x, level up, transform your.

Keep the account's voice. The supplied voice notes, example posts, and edits outrank generic rhythm advice. Keep supplied specifics, mixed feelings, and uneven sentence lengths where they are natural; do not over-polish distinctive lines into generic prose, and never manufacture typos, slang, or roughness to seem human.

Rhythm: vary sentence length, do not force triads, do not cycle synonyms for the same thing (repeat the right word), and do not stack dashes or fragments for drama.

End on the last concrete consequence, takeaway, or next action. No recap ending, no \"in conclusion\", no \"the future looks bright\", no mic-drop line, no aphorism, no engagement-bait question.";

/// Lane rules for a standalone post.
pub const POST_CODEX: &str = "\
A post is one developed thought, not a stub, a headline, or a thread setup. Shape: the claim, mechanism, or result first; the support from the material; then the tradeoff, limit, or decision the reader can use. Aim for 200-275 characters (hard cap 279) and let the supported thought set the length; only fall back to a one-liner when the material leaves no room. The first five words must carry a concrete anchor from the material: a number, a name, a term, or a mechanism. No hashtags, emojis, links, or \"thread\" framing unless the supplied material already contains them. A reader should be able to restate the one claim after a single read.";

/// Lane rules for a reply.
pub const REPLY_CODEX: &str = "\
A reply is a comment to the author, not a small post. React to the author's actual point: answer their question, disagree with a reason, add the missing mechanism, or name the tradeoff. Lead with the reaction; do not restate or re-explain what they already said. One thought, one or two short lines, the way a person types it: contractions, sentence case, normal punctuation.

If the target asks a question, answer it directly with the pick you would defend, at most one line of why. Do not weigh options or write a survey. Do not give advice, corrections, lectures, or best-practice tips unless the author asked. No pleasantry openers (\"great point\"), no quoting their words back, no replying to other commenters, no numbering points unless the target is a numbered list, and no engagement-bait questions.";

/// The cut-only checklist for the revision pass.
pub const REVISION_CHECKLIST: &str = "\
Delete, do not rewrite into something new:
- any sentence that restates the opening, the material, or the obvious;
- throat-clearing, faux-insight setups, staged run-ups, and rhetorical-question openers;
- \"not X, it's Y\" / \"isn't just X, it's Y\" skeletons and other importance staging;
- inflation (pivotal, testament, marks a moment), borrowed authority, and sales language;
- trailing \"-ing\" clauses that claim significance instead of showing it;
- unclear nouns, stacked abstractions, and claims the material does not support;
- the closing line if it recaps, applauds, or turns the point into an aphorism.

Keep the account voice and every supported specific. If a draft already passes, return it unchanged. Do not add facts, examples, angles, or hedges.";

// ---------------------------------------------------------------------------
// Deterministic catalogue (gate-side)
// ---------------------------------------------------------------------------

const ANY_LANE: u8 = 0b11;
const POST_ONLY: u8 = 0b01;
const REPLY_ONLY: u8 = 0b10;

#[derive(Debug, Clone, Copy)]
pub struct Pattern {
    /// Stable identifier used in tests and screens.
    pub id: &'static str,
    /// Human label for diagnostics.
    pub label: &'static str,
    pub regex: &'static str,
    /// Score penalty when hit (before the cap).
    pub weight: i64,
    /// Hard failures are refused by the approval screen, not just penalised.
    pub hard: bool,
    lanes: u8,
}

/// Structural patterns not already covered by `quality.rs`'s historical
/// tables. Word-level slop (`delve`, `leverage`, …) stays in
/// `zyquor_core::AI_SLOP_PHRASES`.
const PATTERNS: &[Pattern] = &[
    // --- staging instead of stating -------------------------------------
    Pattern {
        id: "binary_contrast_split",
        label: "staged binary contrast (\"not X. it's Y\")",
        regex: r"(?i)(?:\bnot|\bisn'?t|\baren'?t|\bwasn'?t|\bweren'?t|\bthis is not|\bit'?s not)\b[^.!?\n]{1,60}[.!?]\s+(?:it'?s|it is|that'?s|the (?:real|actual))\b",
        weight: 3,
        hard: true,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "binary_contrast_inline",
        label: "binary contrast (\"not X, it's Y\")",
        regex: r"(?i)\b(?:it'?s|this is|that'?s|isn'?t|aren'?t|wasn'?t|weren'?t) not (?:just )?[^.!?\n]{1,60}, (?:it'?s|it is|they'?re|that'?s)\b|\bnot just [a-z][\w' -]{1,40} but (?:also )?[a-z]",
        weight: 3,
        hard: true,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "throat_clearing",
        label: "throat-clearing opener",
        regex: r"(?i)\b(?:here'?s the thing|here'?s what i mean|let me be clear|i'?ll be honest|the truth is|the reality is|the uncomfortable truth is|at the end of the day|it'?s worth noting|it'?s important to note|when it comes to)\b",
        weight: 2,
        hard: true,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "faux_insight",
        label: "faux-insight setup",
        regex: r"(?i)\b(?:(?:what )?nobody (?:tells you|talks about|told you)|the part (?:everyone|most people) (?:misses|miss|skips)|what most people get wrong|the thing nobody (?:tells|says)|here'?s what nobody)\b",
        weight: 3,
        hard: true,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "rhetorical_setup",
        label: "rhetorical or staged run-up",
        regex: r"(?i)^(?:what if i told you|think about it|plot twist|imagine (?:this|if|a world)|picture this)\b|\b(?:think about it|plot twist):",
        weight: 2,
        hard: false,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "importance_puffery",
        label: "importance puffery without mechanism",
        regex: r"(?i)\b(?:a? ?(?:pivotal|watershed) (?:moment|shift)|testament to|m(?:arks|arking) a (?:turning point|new era|new chapter|pivotal)|ushers? in|sets? the stage for|solidifies? (?:its|the)|underscores? (?:the )?(?:importance|significance)|reflects? a broader|plays? a (?:vital|crucial|key) role)\b",
        weight: 3,
        hard: true,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "weasel_attribution",
        label: "borrowed authority (\"experts agree\", \"studies show\")",
        regex: r"(?i)\b(?:(?:experts|analysts|observers|industry reports?|studies|research|researchers|many people|most people) (?:agree|says?|suggest|shows?|notes?|finds?)|(?:many|most) (?:argue|believe|say)|widely (?:regarded|considered))\b",
        weight: 3,
        hard: true,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "participle_tail",
        label: "trailing -ing significance clause",
        regex: r"(?i),\s+(?:highlighting|underscoring|reflecting|showcasing|emphasizing|symbolizing|demonstrating|illustrating|capturing|cementing|solidifying|reinforcing|marking)\b",
        weight: 2,
        hard: true,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "meta_commentary",
        label: "interpretive metadiscourse",
        regex: r"(?i)\b(?:the key point is|as you can see|this distinction matters|that last part matters|in other words|the important thing here|what matters here)\b",
        weight: 2,
        hard: false,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "negative_listing",
        label: "negative listing (\"Not X. Not Y. Z.\")",
        regex: r"(?i)(?:^|[.!?]\s+)(?:not|no)\s+[a-z][\w' -]{1,24}[.!?]\s+(?:not|no)\s+[a-z]",
        weight: 2,
        hard: false,
        lanes: ANY_LANE,
    },
    // --- inflation and leftovers ----------------------------------------
    Pattern {
        id: "sales_language",
        label: "sales or hype language",
        regex: r"(?i)\b(?:unlock(?:s|ed|ing)? (?:the )?(?:power|potential)|supercharge[ds]?|game[- ]chang(?:er|ing)|revolutioni[sz](?:e|ing|ed)|transform(?:s|ing)? (?:your|the way)|take (?:it|this|you) to the next level|10x (?:your|the)|level(?:s)? up)\b",
        weight: 3,
        hard: true,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "chat_residue",
        label: "chat residue (\"great question\", \"happy to help\")",
        regex: r"(?i)\b(?:great|good) (?:question|point|post)|happy to help|hope (?:this|that) helps|let me know if|don'?t hesitate to|would you like me to|as an ai\b|in this (?:post|article|thread)\b",
        weight: 3,
        hard: true,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "recap_ending",
        label: "summary-recap ending",
        regex: r"(?i)(?:^|[.!?]\s+)(?:in conclusion|ultimately|all in all|overall)[, ]|\bthe future (?:looks|is) bright\b|\bexciting times (?:are )?ahead\b|\bdespite (?:these |the )?challenges\b",
        weight: 3,
        hard: true,
        lanes: ANY_LANE,
    },
    Pattern {
        id: "mic_drop_closer",
        label: "mic-drop or applause closer",
        regex: r"(?i)\b(?:let that sink in|read that again|that'?s the real (?:win|magic|point|lesson)|the results speak for themselves|mic drop|and that'?s (?:the|a) (?:point|lesson)|that'?s it\.? that'?s the)\b",
        weight: 3,
        hard: true,
        lanes: ANY_LANE,
    },
    // --- reply-lane specific -------------------------------------------
    Pattern {
        id: "reply_pleasantry",
        label: "reply pleasantry opener",
        regex: r"(?i)^(?:great|good|interesting|cool|nice|fair) (?:point|post|thread|question|take)\b",
        weight: 2,
        hard: true,
        lanes: REPLY_ONLY,
    },
    Pattern {
        id: "reply_advice_opener",
        label: "unrequested advice or lecture opener",
        regex: r"(?i)^(?:you (?:should|need to|must)|consider (?:using|trying)|make sure|have you (?:tried|considered)|i'?d recommend|pro tip)\b",
        weight: 2,
        hard: false,
        lanes: REPLY_ONLY,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub id: &'static str,
    pub label: &'static str,
    pub hard: bool,
}

fn lane_matches(pattern: &Pattern, lane: Lane) -> bool {
    let bit = match lane {
        Lane::Post => POST_ONLY,
        Lane::Reply => REPLY_ONLY,
    };
    pattern.lanes & bit != 0 || pattern.lanes == ANY_LANE
}

/// Structural slop findings for one lane. Deduplicated by pattern id.
pub fn findings(text: &str, lane: Lane) -> Vec<Finding> {
    let mut found: Vec<Finding> = Vec::new();
    for pattern in PATTERNS {
        if !lane_matches(pattern, lane) || found.iter().any(|hit| hit.id == pattern.id) {
            continue;
        }
        let matched = Regex::new(pattern.regex)
            .map(|regex| regex.is_match(text).unwrap_or(false))
            .unwrap_or(false);
        if matched {
            found.push(Finding {
                id: pattern.id,
                label: pattern.label,
                hard: pattern.hard,
            });
        }
    }
    found
}

/// Score penalty for the structural findings, capped so a single noisy quote
/// cannot push an otherwise specific post to zero.
pub fn penalty(text: &str, lane: Lane) -> i64 {
    let total: i64 = PATTERNS
        .iter()
        .filter(|pattern| lane_matches(pattern, lane))
        .filter(|pattern| {
            Regex::new(pattern.regex)
                .map(|regex| regex.is_match(text).unwrap_or(false))
                .unwrap_or(false)
        })
        .map(|pattern| pattern.weight)
        .sum();
    total.min(9)
}

/// High-confidence hard failures for the approval screen.
pub fn hard_failures(text: &str, lane: Lane) -> Vec<Finding> {
    findings(text, lane)
        .into_iter()
        .filter(|finding| finding.hard)
        .collect()
}

/// `true` when the text passes the structural craft gate.
pub fn is_craft_clean(text: &str, lane: Lane) -> bool {
    hard_failures(text, lane).is_empty()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn ids(text: &str, lane: Lane) -> Vec<&'static str> {
        findings(text, lane).into_iter().map(|hit| hit.id).collect()
    }

    #[test]
    fn catches_staged_binary_contrasts() {
        for text in [
            "This isn't about speed. It's about trust.",
            "The point isn't the model. It's the eval.",
            "It's not a tool, it's a workflow.",
            "The problem isn't latency. It's queuing.",
        ] {
            let found = ids(text, Lane::Post);
            assert!(
                found.contains(&"binary_contrast_split")
                    || found.contains(&"binary_contrast_inline"),
                "missed: {text} -> {found:?}"
            );
        }
    }

    #[test]
    fn allows_an_earned_single_sentence_contrast() {
        // A direct "not X but Y" is stylistic pressure, not a hard failure; the
        // split-sentence staging is what the gate refuses.
        assert!(is_craft_clean(
            "The queue, not the model, is where p99 goes.",
            Lane::Post
        ));
    }

    #[test]
    fn catches_throat_clearing_and_faux_insight() {
        assert!(ids("Here's the thing: caching is hard.", Lane::Post).contains(&"throat_clearing"));
        assert!(
            ids(
                "What nobody tells you about caching is that it lies.",
                Lane::Post
            )
            .contains(&"faux_insight")
        );
        assert!(
            ids(
                "The part everyone misses is the eviction policy.",
                Lane::Post
            )
            .contains(&"faux_insight")
        );
    }

    #[test]
    fn catches_inflation_puffery_and_borrowed_authority() {
        assert!(
            ids(
                "The launch is a testament to the team's commitment to innovation.",
                Lane::Post
            )
            .contains(&"importance_puffery")
        );
        assert!(
            ids(
                "Experts agree that local models are the future.",
                Lane::Post
            )
            .contains(&"weasel_attribution")
        );
        assert!(
            ids(
                "The launch adds search, highlighting the team's focus.",
                Lane::Post
            )
            .contains(&"participle_tail")
        );
    }

    #[test]
    fn catches_closers_and_chat_residue() {
        assert!(
            ids("We cut p99 to 80ms. Let that sink in.", Lane::Post).contains(&"mic_drop_closer")
        );
        assert!(
            ids("In conclusion, the queue was the bottleneck.", Lane::Post)
                .contains(&"recap_ending")
        );
        assert!(
            ids("Great question. The queue is the bottleneck.", Lane::Reply)
                .contains(&"reply_pleasantry")
        );
        assert!(
            ids("This ships next week. Hope this helps!", Lane::Post).contains(&"chat_residue")
        );
    }

    #[test]
    fn reply_only_patterns_do_not_fire_on_posts() {
        assert!(!ids("Great point about queues.", Lane::Post).contains(&"reply_pleasantry"));
        assert!(ids("Great point about queues.", Lane::Reply).contains(&"reply_pleasantry"));
    }

    #[test]
    fn specific_technical_prose_stays_clean() {
        let clean = "We replaced the whole queue with one mutex because throughput was 4x better under load. p99 dropped from 900ms to 210ms.";
        assert_eq!(findings(clean, Lane::Post), Vec::new());
        assert_eq!(penalty(clean, Lane::Post), 0);
    }

    #[test]
    fn penalty_is_capped() {
        let stacked = "Here's the thing: this is a testament to innovation. What nobody tells you is experts agree. Let that sink in.";
        assert_eq!(penalty(stacked, Lane::Post), 9);
    }

    #[test]
    fn every_pattern_compiles() {
        for pattern in PATTERNS {
            let compiled = Regex::new(pattern.regex);
            assert!(compiled.is_ok(), "{}: {:?}", pattern.id, compiled.err());
        }
    }
}
