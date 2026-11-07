//! Post-history snapshot, ported from `apps/api/src/lib/post-history-snapshot.ts`
//! plus the `sourcePacketIdForDraft` helper from `lib/source-packet.ts`.

use serde_json::{Map, Value};

/// `sourcePacketIdForDraft(repository, draftId)`.
pub async fn source_packet_id_for_draft(
    repository: &crate::state::Repository,
    draft_id: &str,
) -> Result<Option<String>, zyquor_storage::StorageError> {
    let draft = repository.get_draft(draft_id).await?;
    if let Some(item) = &draft {
        if let Some(Value::String(id)) = item.draft.metadata.get("sourcePacketId") {
            return Ok(Some(id.clone()));
        }
        for candidate in &item.candidates {
            if let Some(Value::String(id)) = candidate.score.get("sourcePacketId") {
                return Ok(Some(id.clone()));
            }
        }
    }
    Ok(None)
}

fn metadata_source_type(value: Option<&Value>) -> Option<String> {
    let Value::String(text) = value? else {
        return None;
    };
    if zyquor_core::types::SourceType::ALL
        .iter()
        .any(|ty| ty.as_str() == text)
    {
        Some(text.clone())
    } else {
        None
    }
}

fn metadata_tweet_type(value: Option<&Value>) -> Option<String> {
    let Value::String(text) = value? else {
        return None;
    };
    if zyquor_core::types::TweetType::ALL
        .iter()
        .any(|ty| ty.as_str() == text)
    {
        Some(text.clone())
    } else {
        None
    }
}

/// `postHistorySnapshot(repository, draftId)`.
pub async fn post_history_snapshot(
    repository: &crate::state::Repository,
    draft_id: &str,
) -> Result<serde_json::Value, zyquor_storage::StorageError> {
    let draft = repository.get_draft(draft_id).await?;
    let source_packet_id = match &draft {
        Some(_) => source_packet_id_for_draft(repository, draft_id).await?,
        None => None,
    };
    let packet = match &source_packet_id {
        Some(id) => repository.get_source_packet(id).await?,
        None => None,
    };
    let metadata: Map<String, Value> = match &draft {
        Some(item) => item.draft.metadata.clone(),
        None => Map::new(),
    };

    let mut inner_metadata = Map::new();
    inner_metadata.insert("draftMetadata".to_string(), Value::Object(metadata.clone()));
    if let Some(p) = &packet {
        inner_metadata.insert(
            "sourceFacts".to_string(),
            serde_json::to_value(&p.facts).unwrap_or(Value::Array(vec![])),
        );
        inner_metadata.insert(
            "sourceSummary".to_string(),
            Value::String(p.summary.clone()),
        );
    }

    let source_title =
        packet
            .as_ref()
            .map(|p| p.title.clone())
            .or_else(|| match metadata.get("sourceTitle") {
                Some(Value::String(text)) => Some(text.clone()),
                _ => None,
            });
    let source_url =
        packet
            .as_ref()
            .and_then(|p| p.url.clone())
            .or_else(|| match metadata.get("sourceUrl") {
                Some(Value::String(text)) => Some(text.clone()),
                _ => None,
            });
    let source_type = packet
        .as_ref()
        .map(|p| p.source_type.clone())
        .or_else(|| metadata_source_type(metadata.get("sourceType")));
    let tweet_type = packet
        .as_ref()
        .map(|p| p.tweet_type.clone())
        .or_else(|| metadata_tweet_type(metadata.get("tweetType")));

    Ok(serde_json::json!({
        "metadata": inner_metadata,
        "sourcePacketId": source_packet_id,
        "sourceTitle": source_title,
        "sourceType": source_type,
        "sourceUrl": source_url,
        "tweetType": tweet_type,
    }))
}
