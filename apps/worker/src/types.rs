//! JSON wire models for the worker's API client.
//!
//! The worker only needs a handful of fields per payload, so these are small
//! plain structs with camelCase serde renames matching the TypeScript wire
//! names (`accountId`, `scheduledFor`, `mode`, ...).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    #[serde(default)]
    pub handle: String,
    #[serde(default)]
    pub enabled: bool,
    pub quiet_hours_start: Option<String>,
    pub quiet_hours_end: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostJob {
    pub id: String,
    pub account_id: String,
    #[serde(default)]
    pub mode: String,
    pub scheduled_for: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePacket {
    pub id: String,
    #[serde(default)]
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestConfigSummary {
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeededConfig {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobsResponse {
    #[serde(default)]
    pub jobs: Vec<PostJob>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountsResponse {
    #[serde(default)]
    pub accounts: Vec<Account>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigsResponse {
    #[serde(default)]
    pub configs: Vec<IngestConfigSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftsResponse {
    #[serde(default)]
    pub drafts: Vec<DraftSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PacketsResponse {
    pub packets: Option<Vec<SourcePacket>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    #[serde(default)]
    pub ok: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverStaleResponse {
    #[serde(default)]
    pub recovered_count: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedResponse {
    pub config: SeededConfig,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestRunResponse {
    #[serde(default)]
    pub accepted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceResponse {
    #[serde(default)]
    pub measured: Vec<serde_json::Value>,
    #[serde(default)]
    pub failed: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MentionDraftResult {
    pub created: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MentionApproveResult {
    pub approved: Option<Vec<serde_json::Value>>,
    pub held: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XSession {
    #[serde(default)]
    pub logged_in: bool,
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatBody {
    pub last_error: Option<String>,
    pub last_ingest_at: Option<String>,
    pub last_post_at: Option<String>,
}
