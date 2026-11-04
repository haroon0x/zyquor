//! Reply-target URL parsing, ported from `parseReplyTargetUrl`.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyTarget {
    pub tweet_id: String,
    pub author_handle: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ReplyTargetError {
    #[error("not an https x.com/twitter.com status URL")]
    NotAStatusUrl,
}

/// Returns `None` for anything that is not an `https://x.com/<handle>/status/<id>`
/// or `https://twitter.com/<handle>/status/<id>` URL.
pub fn parse_reply_target_url(raw: &str) -> Option<ReplyTarget> {
    try_parse_reply_target_url(raw).ok()
}

fn try_parse_reply_target_url(raw: &str) -> Result<ReplyTarget, ReplyTargetError> {
    let parsed = Url::parse(raw).map_err(|_| ReplyTargetError::NotAStatusUrl)?;

    if parsed.scheme() != "https" {
        return Err(ReplyTargetError::NotAStatusUrl);
    }
    if !matches!(parsed.host_str(), Some("x.com" | "twitter.com")) {
        return Err(ReplyTargetError::NotAStatusUrl);
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.port().is_some() {
        return Err(ReplyTargetError::NotAStatusUrl);
    }

    let (handle, id) = split_status_path(parsed.path()).ok_or(ReplyTargetError::NotAStatusUrl)?;

    Ok(ReplyTarget {
        tweet_id: id.to_string(),
        author_handle: handle.to_string(),
        url: raw.to_string(),
        author_name: None,
        text: None,
    })
}

/// `^/([A-Za-z0-9_]{1,15})/status/(\d+)/?$`
fn split_status_path(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix('/')?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);

    let (handle, remainder) = rest.split_once('/')?;
    if !is_handle(handle) {
        return None;
    }

    let id = remainder.strip_prefix("status/")?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }

    Some((handle, id))
}

fn is_handle(value: &str) -> bool {
    (1..=15).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}
