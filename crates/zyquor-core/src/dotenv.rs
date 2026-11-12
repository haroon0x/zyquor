//! `.env` loading for the process entry points.
//!
//! The retired TypeScript tree imported `dotenv` at startup; the Rust
//! binaries call [`load`] first thing in `main`. Variables that are already
//! set in the process environment always win, so shell exports still override
//! `.env` exactly like `dotenv.config({ override: false })`.

/// Load the nearest `.env` (the current directory and its parents) into the
/// process environment without overriding existing variables.
///
/// A missing or unreadable file is not an error, matching `dotenv.config()`.
pub fn load() {
    let _ = dotenvy::dotenv();
}
