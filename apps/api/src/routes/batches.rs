//! Batch draft routes, ported from `apps/api/src/routes/batches.ts`.

use axum::{Json, Router, extract::State, http::StatusCode, routing::post};
use serde_json::{Map, Value, json};

use crate::errors::{ApiError, Issue};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/draft-batches", post(create_batch))
}

fn add_minutes(timestamp: &str, minutes: i64) -> String {
    let base = chrono::DateTime::parse_from_rfc3339(timestamp)
        .map(|parsed| parsed.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    (base + chrono::Duration::minutes(minutes)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn is_valid_iso(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn is_valid_url(value: &str) -> bool {
    url::Url::parse(value).is_ok()
}

struct BatchInput {
    account_id: String,
    ideas: Vec<String>,
    mode: Option<String>,
    schedule_spacing_minutes: Option<i64>,
    schedule_start: Option<Option<String>>,
    reply_to_url: Option<String>,
    tweet_type: Option<String>,
    yolo: bool,
    autopost: bool,
}

fn parse_batch(value: &Value) -> Result<BatchInput, ApiError> {
    let obj = value.as_object().ok_or_else(|| {
        ApiError::invalid_with_issues(vec![Issue {
            path: String::new(),
            message: "expected an object".to_string(),
        }])
    })?;
    let mut issues = Vec::new();

    let account_id = match obj.get("accountId") {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::String(_)) => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "String must contain at least 1 character(s)".to_string(),
            });
            String::new()
        }
        Some(_) => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
        None => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };

    let ideas = match obj.get("ideas") {
        Some(Value::Array(items)) => {
            if items.is_empty() || items.len() > 10 {
                issues.push(Issue {
                    path: "ideas".to_string(),
                    message: "Array must contain between 1 and 10 item(s)".to_string(),
                });
            }
            let mut out = Vec::new();
            for (index, item) in items.iter().enumerate() {
                match item {
                    Value::String(text) if !text.is_empty() && text.len() <= 4000 => {
                        out.push(text.clone())
                    }
                    Value::String(text) => {
                        issues.push(Issue {
                            path: format!("ideas.{index}"),
                            message: if text.is_empty() {
                                "String must contain at least 1 character(s)".to_string()
                            } else {
                                "String must contain at most 4000 character(s)".to_string()
                            },
                        });
                    }
                    _ => issues.push(Issue {
                        path: format!("ideas.{index}"),
                        message: "Required".to_string(),
                    }),
                }
            }
            out
        }
        Some(_) => {
            issues.push(Issue {
                path: "ideas".to_string(),
                message: "Required".to_string(),
            });
            Vec::new()
        }
        None => {
            issues.push(Issue {
                path: "ideas".to_string(),
                message: "Required".to_string(),
            });
            Vec::new()
        }
    };

    let mode = match obj.get("mode") {
        None => None,
        Some(Value::String(text)) => {
            if zyquor_core::types::PostingMode::ALL
                .iter()
                .any(|m| m.as_str() == text)
            {
                Some(text.clone())
            } else {
                issues.push(Issue {
                    path: "mode".to_string(),
                    message: format!(
                        "Invalid enum value. Expected one of {:?}",
                        zyquor_core::types::POSTING_MODES
                            .iter()
                            .map(|m| m.as_str())
                            .collect::<Vec<_>>()
                    ),
                });
                None
            }
        }
        Some(_) => {
            issues.push(Issue {
                path: "mode".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };

    let schedule_spacing_minutes = match obj.get("scheduleSpacingMinutes") {
        None => None,
        Some(Value::Number(number)) => match number.as_i64() {
            Some(value)
                if number.as_f64().is_some_and(|f| f.fract() == 0.0)
                    && (15..=480).contains(&value) =>
            {
                Some(value)
            }
            _ => {
                issues.push(Issue {
                    path: "scheduleSpacingMinutes".to_string(),
                    message: "Number must be an integer between 15 and 480".to_string(),
                });
                None
            }
        },
        Some(_) => {
            issues.push(Issue {
                path: "scheduleSpacingMinutes".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };

    let schedule_start = match obj.get("scheduleStart") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(text)) => {
            if is_valid_iso(text) {
                Some(Some(text.clone()))
            } else {
                issues.push(Issue {
                    path: "scheduleStart".to_string(),
                    message: "String must be a valid ISO 8601 date".to_string(),
                });
                None
            }
        }
        Some(_) => {
            issues.push(Issue {
                path: "scheduleStart".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };

    let reply_to_url = match obj.get("replyToUrl") {
        None => None,
        Some(Value::String(text)) => {
            if is_valid_url(text) {
                Some(text.clone())
            } else {
                issues.push(Issue {
                    path: "replyToUrl".to_string(),
                    message: "Invalid url".to_string(),
                });
                None
            }
        }
        Some(_) => {
            issues.push(Issue {
                path: "replyToUrl".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };

    let tweet_type = match obj.get("tweetType") {
        None => None,
        Some(Value::String(text)) => {
            if zyquor_core::types::TweetType::ALL
                .iter()
                .any(|t| t.as_str() == text)
            {
                Some(text.clone())
            } else {
                issues.push(Issue {
                    path: "tweetType".to_string(),
                    message: "Invalid enum value".to_string(),
                });
                None
            }
        }
        Some(_) => {
            issues.push(Issue {
                path: "tweetType".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };

    let yolo = match obj.get("yolo") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            issues.push(Issue {
                path: "yolo".to_string(),
                message: "Required".to_string(),
            });
            false
        }
    };
    let autopost = match obj.get("autopost") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            issues.push(Issue {
                path: "autopost".to_string(),
                message: "Required".to_string(),
            });
            false
        }
    };

    if issues.is_empty() {
        Ok(BatchInput {
            account_id,
            ideas,
            mode,
            schedule_spacing_minutes,
            schedule_start,
            reply_to_url,
            tweet_type,
            yolo,
            autopost,
        })
    } else {
        Err(ApiError::invalid_with_issues(issues))
    }
}

async fn create_batch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let input = parse_batch(&body)?;
    let schedule_start_text: Option<String> = input.schedule_start.clone().flatten();
    if input.mode.as_deref() == Some("scheduled") && schedule_start_text.is_none() {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "scheduleStart is required for scheduled batch jobs"})),
        ));
    }
    let repository = state.repository();
    let schedule_spacing_minutes = input.schedule_spacing_minutes.unwrap_or(90);
    let default_mode = match &input.mode {
        Some(mode) => mode.clone(),
        None => {
            if schedule_start_text.is_some() {
                "scheduled".to_string()
            } else {
                "prepare_only".to_string()
            }
        }
    };
    let mode = if input.yolo && input.autopost {
        "autopost".to_string()
    } else if input.yolo {
        "prepare_only".to_string()
    } else {
        default_mode
    };
    let mut created = Vec::new();
    for (index, idea) in input.ideas.iter().enumerate() {
        let mut metadata = Map::new();
        metadata.insert("lane".to_string(), Value::String("batch".to_string()));
        metadata.insert("yolo".to_string(), Value::Bool(input.yolo));
        metadata.insert("autopost".to_string(), Value::Bool(input.autopost));
        metadata.insert("mode".to_string(), Value::String(mode.clone()));
        metadata.insert(
            "tweetType".to_string(),
            Value::String(
                input
                    .tweet_type
                    .clone()
                    .unwrap_or_else(|| "useful_info".to_string()),
            ),
        );
        let schedule_start = match &schedule_start_text {
            Some(start) => Value::String(add_minutes(
                start,
                (index as i64) * schedule_spacing_minutes,
            )),
            None => Value::Null,
        };
        metadata.insert("scheduleStart".to_string(), schedule_start);
        let draft = repository
            .create_draft(zyquor_storage::NewDraft {
                account_id: input.account_id.clone(),
                source_input: idea.clone(),
                candidates: Vec::new(),
                reply_to: None,
                reply_to_url: input.reply_to_url.clone(),
                metadata,
            })
            .await?;
        created.push(draft);
    }
    Ok((StatusCode::CREATED, Json(json!({"items": created}))))
}
