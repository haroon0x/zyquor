//! Draft building, ported from `packages/automation/src/draft.ts`.

use std::sync::Arc;

use chrono::DateTime;
use serde_json::{Map, Value};
use zyquor_core::types::PostingMode;
use zyquor_generation::providers::DraftGenerationProvider;
use zyquor_generation::quality::{
    format_tweet_text, passes_tweet_quality_floor, post_process_tweet_text, score_tweet_quality,
};
use zyquor_generation::types::{GenerateDraftCandidatesInput, GeneratedDraftCandidate};
use zyquor_storage::{NewCandidate, NewDraft, SourcePacket, SqliteRepository};

use crate::account_context::account_generation_context;
use crate::packet::{article_tweet_idea, has_enough_source_context, source_tweet_input};
use crate::quality::{validate_source_post_quality, with_required_source_url};
use crate::routing::normalize_tweet_type;
use crate::topic::has_topic_overlap;
use crate::{AutomationDeps, AutomationError};

const DRAFT_TOPIC_DEDUPE_DAYS: i64 = 7;

#[derive(Debug, Clone)]
pub struct TopicDraftExistsError {
    pub topic_title: String,
    pub existing_title: String,
    pub account_id: String,
}

impl std::fmt::Display for TopicDraftExistsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Draft already exists for this topic ({})",
            self.topic_title
        )
    }
}

impl std::error::Error for TopicDraftExistsError {}

#[derive(Debug, Clone, Default)]
pub struct PacketDraftOptions {
    pub auto_approve: bool,
    pub count: Option<usize>,
    pub media_urls: Option<Vec<String>>,
    pub mode: Option<PostingMode>,
}

#[derive(Debug, Clone)]
pub struct PacketDraftResult {
    pub approved: Option<(zyquor_storage::Draft, zyquor_storage::PostJob)>,
    pub candidates: Vec<zyquor_storage::DraftCandidate>,
    pub draft: zyquor_storage::Draft,
    pub packet: SourcePacket,
}

fn parse_millis(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .ok()
}

pub async fn generate_candidates_for_packet(
    repository: &SqliteRepository,
    provider: &dyn DraftGenerationProvider,
    packet: &SourcePacket,
    quality_min: f64,
    count: Option<usize>,
) -> Result<Vec<GeneratedDraftCandidate>, AutomationError> {
    if !has_enough_source_context(&packet.title, &packet.summary, &packet.facts) {
        return Ok(Vec::new());
    }
    let context = account_generation_context(repository, &packet.account_id)?;
    let tweet_context = source_tweet_input(packet);

    let candidates = provider
        .generate_draft_candidates(&GenerateDraftCandidatesInput {
            idea: packet.title.clone(),
            context: Some(tweet_context),
            count: count.or(Some(1)),
            preserve_case: true,
            banned_phrases: context.banned_phrases,
            example_posts: context.example_posts,
            objective: context.objective,
            system_prompt_extra: context.system_prompt_extra,
            system_feedback: context.system_feedback,
            tone: context.tone,
            account_knowledge: context.account_knowledge,
            recent_post_history: context.recent_post_history,
            feedback: packet.feedback.clone(),
            tweet_type: Some(
                normalize_tweet_type(&packet.tweet_type)
                    .as_str()
                    .to_string(),
            ),
            ..GenerateDraftCandidatesInput::default()
        })
        .await?;

    if packet.source_type == "x-feed" {
        let passing: Vec<GeneratedDraftCandidate> = candidates
            .into_iter()
            .filter(|candidate| {
                passes_tweet_quality_floor(&format_tweet_text(&candidate.text), quality_min)
            })
            .collect();
        if passing.is_empty() {
            return Err(AutomationError::NoCandidates {
                provider: provider.name().to_string(),
            });
        }
        return Ok(passing);
    }

    Ok(candidates)
}

fn assert_single_draft_per_topic(
    repository: &SqliteRepository,
    account_id: &str,
    packet_id: &str,
    title: &str,
    now: DateTime<chrono::Utc>,
) -> Result<(), AutomationError> {
    let cutoff_millis = now.timestamp_millis() - DRAFT_TOPIC_DEDUPE_DAYS * 24 * 60 * 60 * 1000;
    let cutoff = crate::dates::iso_from_millis(cutoff_millis);
    let drafts = repository.list_drafts(Some(account_id))?;
    let packets = repository.list_source_packets(Some(account_id), None, None)?;

    let title_by_packet_id: std::collections::HashMap<String, String> = packets
        .iter()
        .map(|packet| (packet.id.clone(), packet.title.clone()))
        .collect();

    for draft in drafts {
        if draft.status == zyquor_core::types::DraftStatus::Archived
            || draft.created_at.as_str() < cutoff.as_str()
        {
            continue;
        }
        let Some(source_packet_id) = draft.metadata.get("sourcePacketId").and_then(Value::as_str)
        else {
            continue;
        };
        if source_packet_id == packet_id {
            continue;
        }
        let Some(existing_title) = title_by_packet_id.get(source_packet_id) else {
            continue;
        };
        if has_topic_overlap(title, std::slice::from_ref(existing_title)) {
            return Err(AutomationError::TopicDraftExists {
                topic_title: title.to_string(),
                existing_title: existing_title.clone(),
                account_id: account_id.to_string(),
            });
        }
    }
    Ok(())
}

fn raw_score_map(candidate: &GeneratedDraftCandidate) -> Map<String, Value> {
    let mut score = Map::new();
    score.insert(
        "provider".to_string(),
        Value::String(candidate.provider.clone()),
    );
    score.insert("model".to_string(), Value::String(candidate.model.clone()));
    score.insert("rank".to_string(), Value::from(candidate.rank as i64));
    score.insert("quality".to_string(), Value::from(candidate.quality));
    score
}

fn score_map(candidate: &GeneratedDraftCandidate, packet: &SourcePacket) -> Map<String, Value> {
    let mut score = raw_score_map(candidate);
    score.insert(
        "sourcePacketId".to_string(),
        Value::String(packet.id.clone()),
    );
    score.insert(
        "sourceType".to_string(),
        Value::String(packet.source_type.clone()),
    );
    score.insert(
        "tweetType".to_string(),
        Value::String(packet.tweet_type.clone()),
    );
    score
}

fn packet_created_at(packet: &SourcePacket) -> DateTime<chrono::Utc> {
    parse_millis(&packet.created_at)
        .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
        .unwrap_or_else(chrono::Utc::now)
}

pub async fn draft_from_source_packet(
    repository: &SqliteRepository,
    provider: Arc<dyn DraftGenerationProvider>,
    packet: SourcePacket,
    deps: &AutomationDeps,
    options: PacketDraftOptions,
) -> Result<PacketDraftResult, AutomationError> {
    assert_single_draft_per_topic(
        repository,
        &packet.account_id,
        &packet.id,
        &packet.title,
        packet_created_at(&packet),
    )?;

    let provider_name = provider.name().to_string();
    let mut candidates = generate_candidates_for_packet(
        repository,
        provider.as_ref(),
        &packet,
        deps.quality_min,
        options.count,
    )
    .await?;
    candidates = candidates
        .into_iter()
        .map(|mut candidate| {
            let formatted = if candidate.provider == provider_name {
                format_tweet_text(&candidate.text)
            } else {
                post_process_tweet_text(&candidate.text)
            };
            let normalized = with_required_source_url(&formatted, &packet);
            candidate.quality = score_tweet_quality(&normalized);
            candidate.text = normalized;
            candidate
        })
        .collect();

    let history = if options.auto_approve {
        repository.list_post_history()?
    } else {
        Vec::new()
    };
    let quality_min = deps.quality_min;

    let mut validated: Vec<(
        &GeneratedDraftCandidate,
        crate::quality::PostQualityResult,
        bool,
    )> = candidates
        .iter()
        .map(|candidate| {
            (
                candidate,
                validate_source_post_quality(&candidate.text, &packet, &history),
                passes_tweet_quality_floor(&candidate.text, quality_min),
            )
        })
        .collect();
    validated.sort_by(|a, b| {
        b.0.quality
            .cmp(&a.0.quality)
            .then_with(|| a.0.rank.cmp(&b.0.rank))
    });
    let passing: Vec<(
        &GeneratedDraftCandidate,
        crate::quality::PostQualityResult,
        bool,
    )> = validated
        .into_iter()
        .filter(|(_, validation, generated)| validation.ok && *generated)
        .collect();
    let approved_candidate = passing.first().cloned();

    let mut source_metadata: Map<String, Value> = Map::new();
    if let Some(media_urls) = options
        .media_urls
        .as_ref()
        .filter(|media_urls| !media_urls.is_empty())
    {
        source_metadata.insert(
            "mediaUrls".to_string(),
            Value::Array(
                media_urls
                    .iter()
                    .map(|url| Value::String(url.clone()))
                    .collect(),
            ),
        );
    }
    source_metadata.insert(
        "sourcePacketId".to_string(),
        Value::String(packet.id.clone()),
    );
    source_metadata.insert(
        "sourceType".to_string(),
        Value::String(packet.source_type.clone()),
    );
    source_metadata.insert(
        "tweetType".to_string(),
        Value::String(packet.tweet_type.clone()),
    );

    if let Some((approved, validation, _generated)) = if options.auto_approve {
        approved_candidate
    } else {
        None
    } {
        let mut metadata = source_metadata.clone();
        // TS stores `approvedCandidate.score` — the raw candidate score.
        metadata.insert(
            "generatedScore".to_string(),
            Value::Object(raw_score_map(approved)),
        );
        let created = repository.create_draft(&NewDraft {
            account_id: packet.account_id.clone(),
            source_input: article_tweet_idea(&packet),
            candidates: Vec::new(),
            reply_to: None,
            reply_to_url: None,
            metadata,
        })?;
        let approved_draft_id = created.draft.id.clone();

        let marked_packet = match repository.mark_source_packet_drafted(&packet.id) {
            Ok(marked_packet) => marked_packet,
            Err(error) => {
                let _ = repository.delete_draft(&approved_draft_id);
                return Err(error.into());
            }
        };

        let mode = options.mode.unwrap_or(PostingMode::Autopost);
        let edited_text = validation.text.clone();
        let approved = repository.approve_draft(&zyquor_storage::ApproveDraft {
            draft_id: approved_draft_id.clone(),
            edited_text,
            mode: Some(mode),
            scheduled_for: None,
            reply_to: None,
            reply_to_url: None,
        });
        match approved {
            Ok(approved) => {
                return Ok(PacketDraftResult {
                    approved: Some(approved),
                    candidates: created.candidates,
                    draft: created.draft,
                    packet: marked_packet,
                });
            }
            Err(error) => {
                let _ = repository.delete_draft(&approved_draft_id);
                let _ = repository.reset_source_packet(&packet.id);
                return Err(error.into());
            }
        }
    }

    if options.auto_approve {
        let reason = if candidates.is_empty() {
            Some("no_candidates_generated")
        } else if passing.is_empty() {
            Some("all_below_quality_floor")
        } else {
            None
        };
        let mut gate = Map::new();
        gate.insert("threshold".to_string(), Value::from(quality_min));
        gate.insert(
            "reason".to_string(),
            reason
                .map(|r| Value::String(r.to_string()))
                .unwrap_or(Value::Null),
        );
        gate.insert(
            "candidates".to_string(),
            Value::Array(
                candidates
                    .iter()
                    .map(|candidate| {
                        serde_json::json!({
                            "text": candidate.text,
                            "score": score_map(candidate, &packet),
                            "passedQualityMin": passes_tweet_quality_floor(&candidate.text, quality_min),
                            "reasons": validate_source_post_quality(&candidate.text, &packet, &history).reasons,
                        })
                    })
                    .collect(),
            ),
        );
        source_metadata.insert("qualityGate".to_string(), Value::Object(gate));
    }

    let draft_candidates: Vec<NewCandidate> = candidates
        .iter()
        .map(|candidate| NewCandidate {
            text: candidate.text.clone(),
            score: score_map(candidate, &packet),
        })
        .collect();
    let created = repository.create_draft(&NewDraft {
        account_id: packet.account_id.clone(),
        source_input: article_tweet_idea(&packet),
        candidates: draft_candidates,
        reply_to: None,
        reply_to_url: None,
        metadata: source_metadata,
    })?;

    let marked_packet = repository.mark_source_packet_drafted(&packet.id);
    match marked_packet {
        Ok(marked_packet) => Ok(PacketDraftResult {
            approved: None,
            candidates: created.candidates,
            draft: created.draft,
            packet: marked_packet,
        }),
        Err(error) => {
            let _ = repository.delete_draft(&created.draft.id);
            Err(error.into())
        }
    }
}
