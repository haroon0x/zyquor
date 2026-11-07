//! Style profile routes, ported from `apps/api/src/routes/style-profiles.ts`.

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::get,
};
use serde_json::{Map, Value, json};

use crate::errors::ApiError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/style-profiles/{id}",
        get(get_style_profile).patch(update_style_profile),
    )
}

async fn get_style_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let profile = state.repository().get_style_profile(&id).await?;
    match profile {
        Some(profile) => Ok(Json(json!({"profile": profile}))),
        None => Err(crate::errors::ApiError::http(
            404,
            "Style profile not found",
        )),
    }
}

#[derive(serde::Deserialize, Default)]
struct UpdateStyleProfileRequest {
    #[serde(default, rename = "bannedPhrases")]
    banned_phrases: Option<Vec<String>>,
    #[serde(default, rename = "description")]
    description: Option<Option<String>>,
    #[serde(default, rename = "examplePosts")]
    example_posts: Option<Vec<String>>,
    #[serde(default, rename = "name")]
    name: Option<String>,
    #[serde(default, rename = "rules")]
    rules: Option<Map<String, Value>>,
    #[serde(default, rename = "tone")]
    tone: Option<Option<String>>,
}

async fn update_style_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateStyleProfileRequest>,
) -> Result<Json<Value>, ApiError> {
    if let Some(name) = &input.name {
        if name.is_empty() || name.len() > 120 {
            return Err(crate::errors::ApiError::invalid(
                "name must be 1-120 characters",
            ));
        }
    }
    if let Some(Some(description)) = &input.description {
        if description.len() > 1000 {
            return Err(crate::errors::ApiError::invalid(
                "description must be at most 1000 characters",
            ));
        }
    }
    if let Some(Some(tone)) = &input.tone {
        if tone.len() > 240 {
            return Err(crate::errors::ApiError::invalid(
                "tone must be at most 240 characters",
            ));
        }
    }
    for phrases in [
        input.banned_phrases.as_deref(),
        input.example_posts.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if phrases.iter().any(|phrase| phrase.is_empty()) {
            return Err(crate::errors::ApiError::invalid(
                "phrases must be non-empty strings",
            ));
        }
    }

    let profile = state
        .repository()
        .update_style_profile(
            &id,
            zyquor_storage::StyleProfileUpdate {
                name: input.name,
                description: input.description,
                tone: input.tone,
                rules: input.rules,
                banned_phrases: input.banned_phrases,
                example_posts: input.example_posts,
            },
        )
        .await?;
    Ok(Json(json!({"profile": profile})))
}
