//! Knowledge routes, ported from `apps/api/src/routes/knowledge.ts`.

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch},
};
use serde_json::{Value, json};

use crate::errors::ApiError;
use crate::state::AppState;

const KNOWLEDGE_KINDS: &[&str] = &[
    "product_fact",
    "feature",
    "pricing",
    "persona",
    "opinion_stance",
    "audience",
    "faq",
    "never_claim",
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/knowledge", get(list_knowledge).post(create_knowledge))
        .route(
            "/knowledge/{id}",
            patch(update_knowledge).delete(delete_knowledge),
        )
}

#[derive(serde::Deserialize)]
struct KnowledgeQuery {
    #[serde(default, rename = "accountId")]
    account_id: Option<String>,
}

async fn list_knowledge(
    State(state): State<AppState>,
    Query(query): Query<KnowledgeQuery>,
) -> Result<Json<Value>, ApiError> {
    let account_id = account_id_from(query.account_id.as_deref())?;
    let repository = state.repository();
    if repository.get_account(&account_id).await?.is_none() {
        return Err(crate::errors::ApiError::http(
            404,
            format!("Account not found: {account_id}"),
        ));
    }
    Ok(Json(
        json!({"entries": repository.list_knowledge_entries(&account_id).await?}),
    ))
}

fn account_id_from(value: Option<&str>) -> Result<String, ApiError> {
    match value {
        Some(value) if !value.trim().is_empty() => Ok(value.to_string()),
        _ => Err(crate::errors::ApiError::http(400, "accountId is required")),
    }
}

#[derive(serde::Deserialize)]
struct CreateKnowledgeRequest {
    #[serde(rename = "accountId")]
    account_id: String,
    kind: String,
    title: String,
    content: String,
    #[serde(default, rename = "sourceUrl")]
    source_url: Option<Option<String>>,
}

async fn create_knowledge(
    State(state): State<AppState>,
    Json(input): Json<CreateKnowledgeRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    validate_kind(&input.kind)?;
    validate_title(&input.title)?;
    validate_content(&input.content)?;
    validate_source_url(&input.source_url)?;
    if input.account_id.is_empty() {
        return Err(crate::errors::ApiError::invalid("accountId is required"));
    }

    let repository = state.repository();
    if repository.get_account(&input.account_id).await?.is_none() {
        return Err(crate::errors::ApiError::http(
            404,
            format!("Account not found: {}", input.account_id),
        ));
    }

    // `definedEntries`-style: the nullable-optional sourceUrl passes through
    // (explicit null stays null, absent stays None).
    let entry = repository
        .create_knowledge_entry(zyquor_storage::NewKnowledgeEntry {
            account_id: input.account_id,
            kind: input.kind,
            title: input.title,
            content: input.content,
            source_url: input.source_url.flatten(),
        })
        .await?;
    Ok((StatusCode::CREATED, Json(json!({"entry": entry}))))
}

#[derive(serde::Deserialize, Default)]
struct UpdateKnowledgeRequest {
    kind: Option<String>,
    title: Option<String>,
    content: Option<String>,
    #[serde(default, rename = "sourceUrl")]
    source_url: Option<Option<String>>,
    enabled: Option<bool>,
}

async fn update_knowledge(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateKnowledgeRequest>,
) -> Result<Json<Value>, ApiError> {
    if let Some(kind) = &input.kind {
        validate_kind(kind)?;
    }
    if let Some(title) = &input.title {
        validate_title(title)?;
    }
    if let Some(content) = &input.content {
        validate_content(content)?;
    }
    validate_source_url(&input.source_url)?;

    let entry = state
        .repository()
        .update_knowledge_entry(
            &id,
            zyquor_storage::KnowledgeUpdate {
                kind: input.kind,
                title: input.title,
                content: input.content,
                source_url: input.source_url,
                enabled: input.enabled,
            },
        )
        .await
        .map_err(not_found_or_internal)?;
    Ok(Json(json!({"entry": entry})))
}

async fn delete_knowledge(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let entry = state
        .repository()
        .delete_knowledge_entry(&id)
        .await
        .map_err(not_found_or_internal)?;
    Ok(Json(json!({"entry": entry})))
}

fn not_found_or_internal(error: zyquor_storage::StorageError) -> ApiError {
    let message = error.to_string();
    if message.contains("not found") {
        crate::errors::ApiError::http(404, message)
    } else {
        crate::errors::ApiError::from(error)
    }
}

fn validate_kind(kind: &str) -> Result<(), ApiError> {
    if KNOWLEDGE_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(crate::errors::ApiError::invalid(format!(
            "kind must be one of: {}",
            KNOWLEDGE_KINDS.join(", ")
        )))
    }
}

fn validate_title(title: &str) -> Result<(), ApiError> {
    if title.is_empty() || title.len() > 200 {
        Err(crate::errors::ApiError::invalid(
            "title must be 1-200 characters",
        ))
    } else {
        Ok(())
    }
}

fn validate_content(content: &str) -> Result<(), ApiError> {
    if content.is_empty() || content.len() > 4000 {
        Err(crate::errors::ApiError::invalid(
            "content must be 1-4000 characters",
        ))
    } else {
        Ok(())
    }
}

fn validate_source_url(source_url: &Option<Option<String>>) -> Result<(), ApiError> {
    if let Some(Some(url)) = source_url {
        if url::Url::parse(url).is_err() {
            return Err(crate::errors::ApiError::invalid(
                "sourceUrl must be a valid URL",
            ));
        }
    }
    Ok(())
}
