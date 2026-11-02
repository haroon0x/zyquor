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

// --- remaining repository models ---------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourcePacketStatus {
    New,
    Drafted,
    Archived,
}

impl SourcePacketStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Drafted => "drafted",
            Self::Archived => "archived",
        }
    }
}

impl std::str::FromStr for SourcePacketStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "new" => Ok(Self::New),
            "drafted" => Ok(Self::Drafted),
            "archived" => Ok(Self::Archived),
            other => Err(format!("invalid SourcePacketStatus value: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestRunStatus {
    Running,
    Succeeded,
    Failed,
}

impl IngestRunStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

impl std::str::FromStr for IngestRunStatus {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "running" => Ok(Self::Running),
            "succeeded" => Ok(Self::Succeeded),
            "failed" => Ok(Self::Failed),
            other => Err(format!("invalid IngestRunStatus value: {other}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleProfile {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub tone: Option<String>,
    pub rules: Map<String, Value>,
    pub banned_phrases: Vec<String>,
    pub example_posts: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default)]
pub struct StyleProfileUpdate {
    pub name: Option<String>,
    pub description: Option<Option<String>>,
    pub tone: Option<Option<String>>,
    pub rules: Option<Map<String, Value>>,
    pub banned_phrases: Option<Vec<String>>,
    pub example_posts: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemFeedback {
    pub id: String,
    pub account_id: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEntry {
    pub id: String,
    pub account_id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub source_url: Option<String>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewKnowledgeEntry {
    pub account_id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct KnowledgeUpdate {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub content: Option<String>,
    pub source_url: Option<Option<String>>,
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePacket {
    pub id: String,
    pub account_id: String,
    pub source_type: String,
    pub title: String,
    pub url: Option<String>,
    pub summary: String,
    pub facts: Vec<String>,
    pub tweet_type: String,
    pub status: SourcePacketStatus,
    pub feedback: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewSourcePacket {
    pub account_id: String,
    pub source_type: String,
    pub title: String,
    pub url: Option<String>,
    pub summary: String,
    pub facts: Vec<String>,
    pub tweet_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestRun {
    pub id: String,
    pub config_id: String,
    pub account_id: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub status: IngestRunStatus,
    pub error: Option<String>,
    pub packets_created: i64,
}

#[derive(Debug, Clone)]
pub struct IngestRunUpdate {
    pub status: IngestRunStatus,
    /// Outer `None` keeps the current error.
    pub error: Option<Option<String>>,
    pub packets_created: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TweetMeasurement {
    pub id: String,
    pub account_id: String,
    pub tweet_id: String,
    pub origin: String,
    pub posted_at: Option<String>,
    pub text: Option<String>,
    pub has_link: Option<bool>,
    pub source_type: Option<String>,
    pub tweet_type: Option<String>,
    pub views: Option<i64>,
    pub likes: Option<i64>,
    pub replies: Option<i64>,
    pub reposts: Option<i64>,
    pub bookmarks: Option<i64>,
    pub measured_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewTweetMeasurement {
    pub account_id: String,
    pub tweet_id: String,
    pub origin: String,
    pub posted_at: Option<String>,
    pub text: Option<String>,
    pub has_link: Option<bool>,
    pub source_type: Option<String>,
    pub tweet_type: Option<String>,
    pub views: Option<i64>,
    pub likes: Option<i64>,
    pub replies: Option<i64>,
    pub reposts: Option<i64>,
    pub bookmarks: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestConfig {
    pub id: String,
    pub account_id: String,
    pub source_type: String,
    pub max_packets_per_day: i64,
    pub metadata: Map<String, Value>,
    pub tweet_type_mix: Map<String, Value>,
    pub schedule_window_start: String,
    pub schedule_window_end: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct NewIngestConfig {
    pub account_id: String,
    pub source_type: String,
    pub max_packets_per_day: i64,
    pub metadata: Map<String, Value>,
    pub tweet_type_mix: Map<String, Value>,
    pub schedule_window_start: String,
    pub schedule_window_end: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default)]
pub struct IngestConfigUpdate {
    pub source_type: Option<String>,
    pub max_packets_per_day: Option<i64>,
    pub metadata: Option<Map<String, Value>>,
    pub tweet_type_mix: Option<Map<String, Value>>,
    pub schedule_window_start: Option<String>,
    pub schedule_window_end: Option<String>,
    pub enabled: Option<bool>,
}
