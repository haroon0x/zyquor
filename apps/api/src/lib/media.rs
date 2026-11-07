//! Media downloads for drafts, ported from `apps/api/src/lib/media.ts`.
//!
//! The TypeScript version hashes each URL with SHA-256 and keeps 16 hex
//! characters for the file name. This port reuses
//! `zyquor_storage::hash_post_text` (SHA-256 of the normalised text) to avoid
//! taking a new dependency; the name is still a deterministic 16-character
//! prefix of a SHA-256 digest, so re-downloads land on the same path.

use serde_json::{Map, Value};

fn media_urls_from_draft_metadata(metadata: &Map<String, Value>) -> Vec<String> {
    let Some(Value::Array(urls)) = metadata.get("mediaUrls") else {
        return Vec::new();
    };
    urls.iter()
        .filter_map(|value| match value {
            Value::String(text)
                if text.to_lowercase().starts_with("http://")
                    || text.to_lowercase().starts_with("https://") =>
            {
                Some(text.clone())
            }
            _ => None,
        })
        .take(4)
        .collect()
}

fn extension_for_media(url: &str, content_type: Option<&str>) -> &'static str {
    let path = url.split('?').next().unwrap_or(url);
    let lower = path.to_lowercase();
    if lower.ends_with(".avif")
        || lower.ends_with(".gif")
        || lower.ends_with(".jpg")
        || lower.ends_with(".jpeg")
        || lower.ends_with(".png")
        || lower.ends_with(".webp")
    {
        if lower.ends_with(".avif") {
            return ".avif";
        }
        if lower.ends_with(".gif") {
            return ".gif";
        }
        if lower.ends_with(".png") {
            return ".png";
        }
        if lower.ends_with(".webp") {
            return ".webp";
        }
        return ".jpg";
    }
    if let Some(content_type) = content_type {
        let lower = content_type.to_lowercase();
        if lower.contains("png") {
            return ".png";
        }
        if lower.contains("webp") {
            return ".webp";
        }
        if lower.contains("gif") {
            return ".gif";
        }
        if lower.contains("avif") {
            return ".avif";
        }
    }
    ".jpg"
}

async fn download_media_urls(urls: Vec<String>) -> Result<Vec<String>, String> {
    if urls.is_empty() {
        return Ok(Vec::new());
    }
    let media_dir = zyquor_core::paths::data_path(["media"]);
    std::fs::create_dir_all(&media_dir).map_err(|error| error.to_string())?;
    let client = reqwest::Client::new();
    let mut paths = Vec::new();
    for url in &urls {
        let response = client
            .get(url.as_str())
            .header("user-agent", "Zyquor/1.0")
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Err(format!("Media download failed: {status} {url}"));
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if let Some(ref content_type) = content_type {
            if !content_type.to_lowercase().starts_with("image/") {
                return Err(format!("Media URL is not an image: {url}"));
            }
        }
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
            return Err(format!("Media size is invalid: {url}"));
        }
        let hash = zyquor_storage::hash_post_text(url);
        let short: String = hash.chars().take(16).collect();
        let path = media_dir.join(format!(
            "{short}{}",
            extension_for_media(url, content_type.as_deref())
        ));
        std::fs::write(&path, &bytes).map_err(|error| error.to_string())?;
        paths.push(path.to_string_lossy().to_string());
    }
    Ok(paths)
}

/// `mediaPathsForDraft(draft)`.
pub async fn media_paths_for_draft(metadata: &Map<String, Value>) -> Result<Vec<String>, String> {
    download_media_urls(media_urls_from_draft_metadata(metadata)).await
}
