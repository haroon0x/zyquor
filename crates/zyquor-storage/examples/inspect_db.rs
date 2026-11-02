//! Dumps a Zyquor SQLite database as JSON, for cross-implementation checks.
//!
//! Run: `cargo run -p zyquor-storage --example inspect_db -- /tmp/zyq-cross.db`

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: inspect_db <path-to-db>");
        std::process::exit(2);
    };

    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let repo = zyquor_storage::SqliteRepository::open(&path)?;
        let accounts = repo.list_accounts()?;
        let drafts = repo.list_drafts(None)?;
        let jobs = repo.list_jobs(None, None, None)?;
        let history = repo.list_post_history()?;

        let payload = serde_json::json!({
            "accounts": accounts,
            "drafts": drafts,
            "jobs": jobs,
            "history": history,
        });
        println!("{}", serde_json::to_string_pretty(&payload)?);
        Ok(())
    })();

    if let Err(error) = result {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}
