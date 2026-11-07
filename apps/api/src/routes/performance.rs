//! Performance routes, ported from `apps/api/src/routes/performance.ts`.

use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use serde_json::{Value, json};

use crate::errors::ApiError;
use crate::state::AppState;
use crate::tweet_performance::refresh_tweet_performance;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/performance", get(get_performance))
        .route("/performance/refresh", post(refresh_performance))
}

async fn get_performance(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let history = repository.list_post_history().await?;
    let measurements = repository.list_tweet_measurements(None).await?;
    let history = history
        .into_iter()
        .map(|item| {
            let performance = zyquor_core::types::post_performance_from_metadata(&item.metadata)
                .map(|performance| {
                    json!({
                        "bookmarks": performance.bookmarks,
                        "likes": performance.likes,
                        "measuredAt": performance.measured_at,
                        "replies": performance.replies,
                        "reposts": performance.reposts,
                        "views": performance.views,
                    })
                })
                .unwrap_or(Value::Null);
            let mut value = serde_json::to_value(&item).unwrap_or(Value::Null);
            if let Some(object) = value.as_object_mut() {
                object.insert("performance".to_string(), performance);
            }
            value
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "history": history,
        "measurements": measurements,
    })))
}

async fn refresh_performance(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let result = refresh_tweet_performance(&state).await?;
    Ok(Json(serde_json::to_value(&result).unwrap_or(Value::Null)))
}
