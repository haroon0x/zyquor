//! Ported from `packages/storage/src/utils.ts`.

use sha2::{Digest, Sha256};
use uuid::Uuid;

/// `${prefix}_${randomUUID()}`
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4())
}

/// `text.trim().toLowerCase().replace(/\s+/g, " ")`
pub fn normalize_post_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// SHA-256 (hex) of the normalised text.
pub fn hash_post_text(text: &str) -> String {
    let digest = Sha256::digest(normalize_post_text(text).as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
