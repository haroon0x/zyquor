//! Row models shared by the repository.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use zyquor_core::ReplyTarget;
use zyquor_core::types::{AttemptStatus, DraftStatus, PostJobStatus, PostingMode};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub account_id: String,
    pub source_type: String,
    pub source_input: String,
    pub generated_text: Option<String>,
    pub edited_text: Option<String>,
    pub reply_to: Option<ReplyTarget>,
    pub reply_to_url: Option<String>,
    pub metadata: Map<String, Value>,
    pub status: DraftStatus,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftCandidate {
    pub id: String,
    pub draft_id: String,
    pub text: String,
    pub score: Map<String, Value>,
    pub selected: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftWithCandidates {
    pub draft: Draft,
    pub candidates: Vec<DraftCandidate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostJob {
    pub id: String,
    pub account_id: String,
    pub draft_id: String,
    pub status: PostJobStatus,
    pub mode: PostingMode,
    pub scheduled_for: Option<String>,
    pub reply_to: Option<ReplyTarget>,
    pub reply_to_url: Option<String>,
    pub approved_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostAttempt {
    pub id: String,
    pub job_id: String,
    pub status: AttemptStatus,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub screenshot_path: Option<String>,
    pub trace_path: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostHistory {
    pub id: String,
    pub account_id: String,
    pub draft_id: String,
    pub posted_text: String,
    pub post_url: Option<String>,
    pub source_packet_id: Option<String>,
    pub source_type: Option<String>,
    pub source_title: Option<String>,
    pub source_url: Option<String>,
    pub tweet_type: Option<String>,
    pub metadata: Map<String, Value>,
    pub posted_at: String,
}

/// Inputs ---------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct NewCandidate {
    pub text: String,
    pub score: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub struct NewDraft {
    pub account_id: String,
    pub source_input: String,
    pub candidates: Vec<NewCandidate>,
    pub reply_to: Option<ReplyTarget>,
    pub reply_to_url: Option<String>,
    pub metadata: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub struct ApproveDraft {
    pub draft_id: String,
    pub edited_text: String,
    pub mode: Option<PostingMode>,
    pub scheduled_for: Option<String>,
    pub reply_to: Option<ReplyTarget>,
    pub reply_to_url: Option<String>,
}

/// Partial account update. `None` leaves a field untouched; `Some(None)` on the
/// nested options clears the column.
#[derive(Debug, Clone, Default)]
pub struct AccountUpdate {
    pub display_name: Option<String>,
    pub profile_dir: Option<String>,
    pub posting_mode: Option<PostingMode>,
    pub enabled: Option<bool>,
    pub daily_post_limit: Option<Option<i64>>,
    pub quiet_hours_start: Option<Option<String>>,
    pub quiet_hours_end: Option<Option<String>>,
}

#[derive(Debug, Clone)]
pub struct NewPostHistory {
    pub account_id: String,
    pub draft_id: String,
    pub posted_text: String,
    pub post_url: Option<String>,
    pub source_packet_id: Option<String>,
    pub source_type: Option<String>,
    pub source_title: Option<String>,
    pub source_url: Option<String>,
    pub tweet_type: Option<String>,
    pub metadata: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub struct NewAttempt {
    pub job_id: String,
    pub status: AttemptStatus,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub screenshot_path: Option<String>,
    pub trace_path: Option<String>,
}
