//! HTTP error surface, ported from `apps/api/src/lib/errors.ts`.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};

#[derive(Debug, Clone)]
pub struct HttpError {
    pub status_code: u16,
    pub message: String,
}

impl HttpError {
    pub fn new(status_code: u16, message: impl Into<String>) -> Self {
        Self {
            status_code,
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(404, message)
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, message)
    }
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HttpError {}

#[derive(Debug)]
pub struct Issue {
    pub path: String,
    pub message: String,
}

#[derive(Debug)]
pub enum ApiError {
    Invalid { message: String, issues: Vec<Issue> },
    Http(HttpError),
    Conflict(String),
    Generation(String),
    Internal(String),
}

impl ApiError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid {
            message: message.into(),
            issues: Vec::new(),
        }
    }

    pub fn invalid_with_issues(issues: Vec<Issue>) -> Self {
        Self::Invalid {
            message: "Invalid request".to_string(),
            issues,
        }
    }

    pub fn http(status_code: u16, message: impl Into<String>) -> Self {
        Self::Http(HttpError::new(status_code, message))
    }

    pub fn status(&self) -> u16 {
        match self {
            Self::Invalid { .. } => 400,
            Self::Http(error) => error.status_code,
            Self::Conflict(_) => 409,
            Self::Generation(_) => 503,
            Self::Internal(_) => 500,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status =
            StatusCode::from_u16(self.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        match self {
            Self::Invalid { message: _, issues } => (
                status,
                Json(serde_json::json!({
                    "error": "Invalid request",
                    "issues": issues
                        .into_iter()
                        .map(|issue| serde_json::json!({"path": issue.path, "message": issue.message}))
                        .collect::<Vec<_>>(),
                })),
            )
                .into_response(),
            Self::Http(error) => (status, Json(serde_json::json!({"error": error.message}))).into_response(),
            Self::Conflict(message) => (status, Json(serde_json::json!({"error": message}))).into_response(),
            Self::Generation(message) => (status, Json(serde_json::json!({"error": message}))).into_response(),
            Self::Internal(message) => (status, Json(serde_json::json!({"error": message}))).into_response(),
        }
    }
}

/// The Fastify `setErrorHandler` mapping, minus Zod's `issues` copy.
impl From<zyquor_storage::StorageError> for ApiError {
    fn from(error: zyquor_storage::StorageError) -> Self {
        let message = error.to_string();
        if message.starts_with("Cannot ")
            || message.starts_with("Duplicate ")
            || message.ends_with(" not found")
        {
            return Self::Conflict(message);
        }
        Self::Internal(message)
    }
}

impl From<zyquor_automation::AutomationError> for ApiError {
    fn from(error: zyquor_automation::AutomationError) -> Self {
        match error {
            zyquor_automation::AutomationError::TopicDraftExists { .. } => {
                Self::Conflict(error.to_string())
            }
            zyquor_automation::AutomationError::Provider(error) => {
                Self::Generation(error.to_string())
            }
            zyquor_automation::AutomationError::NoCandidates { provider } => {
                Self::Generation(format!("{provider} returned no draft candidates"))
            }
            zyquor_automation::AutomationError::Storage(error) => Self::from(error),
        }
    }
}

impl From<zyquor_generation::types::GenerationRequestError> for ApiError {
    fn from(error: zyquor_generation::types::GenerationRequestError) -> Self {
        let message = error.to_string();
        if message.starts_with("Generation request failed:")
            || message.starts_with("Command Code")
            || message.contains(" returned no draft candidates")
        {
            Self::Generation(message)
        } else {
            Self::Internal(message)
        }
    }
}

/// `Json` extraction failure -> same 400 shape as Fastify's JSON parser.
pub fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError::invalid(message)
}

pub fn error_response(error: ApiError) -> Response {
    error.into_response()
}

pub fn text(err: ApiError) -> Response {
    err.into_response()
}
