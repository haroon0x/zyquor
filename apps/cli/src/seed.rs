//! `zyquor seed-account [handle] [display name...]` — business account seed.
//!
//! Port of `scripts/seed-business-account.mjs`: idempotent creation of the
//! `style_business` style profile and the `account_business` account with
//! `prepare_only` posting mode, plus the `profiles/<handle>` directory.
//! Existing rows are left untouched.

use crate::cli;

fn valid_handle(handle: &str) -> bool {
    !handle.is_empty()
        && handle.len() <= 15
        && handle
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

fn resolve_data_root() -> std::path::PathBuf {
    let root = std::env::var("ZYQUOR_DATA_ROOT")
        .ok()
        .or_else(|| std::env::var("ZYQUOR_WORKSPACE_ROOT").ok());
    match root {
        Some(value) => std::path::PathBuf::from(value),
        None => std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
    }
}

fn has_accounts_table(path: &std::path::Path) -> bool {
    let Ok(connection) = rusqlite::Connection::open(path) else {
        return false;
    };
    connection
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'",
            [],
            |row| row.get::<_, String>(0),
        )
        .is_ok()
}

fn discover_database_path() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<Option<std::path::PathBuf>> = vec![
        std::env::var("ZYQUOR_DB_PATH")
            .ok()
            .map(std::path::PathBuf::from),
        Some(resolve_data_root().join("data").join("app.sqlite")),
    ];
    candidates.push(None);
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    candidates.push(Some(
        cwd.join("apps").join("api").join("data").join("app.sqlite"),
    ));
    let repo_api = cli::repo_root()
        .join("apps")
        .join("api")
        .join("data")
        .join("app.sqlite");
    candidates.push(Some(repo_api));
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_file() && has_accounts_table(path))
}

const BUSINESS_DESCRIPTION: &str = "Professional brand voice for the business account: product updates, announcements, support replies, customer-facing notes.";
const BUSINESS_TONE: &str = "professional, clear, helpful, concrete";
const BUSINESS_OBJECTIVE: &str = "Represent the brand credibly: inform customers and prospects, announce real product changes, answer questions precisely.";
const BUSINESS_SYSTEM_PROMPT: &str = "You are writing as the official voice of a business, not as a personal account.\nSpeak as 'we' only when describing the company's own product, decisions, and announcements; this is the one lane where 'we' is correct.\nProduct claims must be verifiable from the supplied material. Never promise timelines, pricing, or features that were not supplied.\nSupport replies: acknowledge the actual reported problem in one clause, then give the concrete next step or answer. Never argue with customers.\nAnnouncements: lead with what shipped or changed and who benefits; skip hype adjectives entirely.\nStay courteous under all circumstances; humor allowed but never sarcasm directed at a person or competitor.";

pub fn run(args: &[String]) -> Result<i32, String> {
    let handle = args.first().map(String::as_str).unwrap_or("business");
    if !valid_handle(handle) {
        eprintln!("Invalid handle \"{handle}\": must match /^[a-z0-9_]{{1,15}}$/");
        return Ok(1);
    }
    let display_name = args[1..].join(" ").trim().to_string();
    let display_name = if display_name.is_empty() {
        "Business".to_string()
    } else {
        display_name
    };

    let db_path = discover_database_path();
    let Some(db_path) = db_path else {
        eprintln!("No app.sqlite found. Set ZYQUOR_DB_PATH or run the app once first.");
        return Ok(1);
    };
    let data_root = db_path
        .parent()
        .and_then(|parent| parent.parent())
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    let connection = rusqlite::Connection::open(&db_path)
        .map_err(|error| format!("Cannot open database at {}: {error}", db_path.display()))?;

    let timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let banned: Vec<&str> = vec![
        "game changer",
        "revolutionary",
        "best-in-class",
        "cutting-edge",
        "seamless",
        "synergy",
        "we're excited to announce",
        "thrilled to share",
    ];
    let rules = serde_json::json!({
        "objective": BUSINESS_OBJECTIVE,
        "systemPromptExtra": BUSINESS_SYSTEM_PROMPT,
    });
    let banned_json = serde_json::to_string(&banned).unwrap_or_else(|_| "[]".to_string());

    let style_changes: usize = connection
        .execute(
            "INSERT OR IGNORE INTO style_profiles (
               id, name, description, tone, rules_json, banned_phrases_json, example_posts_json,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                "style_business",
                "Business",
                BUSINESS_DESCRIPTION,
                BUSINESS_TONE,
                rules.to_string(),
                banned_json,
                "[]",
                timestamp,
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;

    let profile_dir = format!("profiles/{handle}");
    let account_changes: usize = connection
        .execute(
            "INSERT OR IGNORE INTO accounts (
               id, handle, display_name, profile_dir, style_profile_id, posting_mode, enabled,
               daily_post_limit, quiet_hours_start, quiet_hours_end, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rusqlite::params![
                "account_business",
                handle,
                display_name,
                profile_dir,
                "style_business",
                "prepare_only",
                1_i64,
                300_i64,
                Option::<String>::None,
                Option::<String>::None,
                timestamp,
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;

    let profile_path = data_root.join(&profile_dir);
    std::fs::create_dir_all(&profile_path).map_err(|error| error.to_string())?;

    println!("Database: {}", db_path.display());
    if style_changes > 0 {
        println!("Created style profile \"style_business\" (Business voice)");
    } else {
        println!("Style profile \"style_business\" already exists, kept current values");
    }
    if account_changes > 0 {
        println!(
            "Created account \"account_business\" (@{handle}, prepare_only, profile dir {profile_dir})"
        );
    } else {
        println!("Account \"account_business\" already exists, kept current values");
    }
    println!("Profile directory ready: {}", profile_path.display());
    println!();
    println!("Next steps:");
    println!("  1. Log into @{handle}: zyquor open-profile --manual");
    println!("  2. Verify login: zyquor check-login");
    println!("  3. Once you have real example tweets from the handle, add them:");
    println!("     PATCH /style-profiles/style_business {{ \"examplePosts\": [...] }}");
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handle_validation() {
        assert!(valid_handle("business"));
        assert!(valid_handle("acme_inc1"));
        assert!(!valid_handle("Business"));
        assert!(!valid_handle("has-dash"));
        assert!(!valid_handle(""));
        assert!(!valid_handle("toolong_handle_16"));
    }
}
