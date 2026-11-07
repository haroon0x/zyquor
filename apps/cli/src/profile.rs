//! `zyquor open-profile [--manual]` and `zyquor check-login`.
//!
//! Ports of `scripts/open-x-profile-cdp.mjs` (non-manual: ensure the CDP
//! Chrome is up then exit), `scripts/open-x-profile-manual.mjs` (`--manual`:
//! open a normal logged-in browser at the X login page and wait for Enter),
//! and `scripts/check-x-login.mjs` (per-profile login check, exit 0 only
//! when logged in). All browser work goes through `zyquor_browser`.

use std::io::BufRead;

use crate::cli;

fn profile_dir() -> std::path::PathBuf {
    let value = cli::env_or("ZYQUOR_X_PROFILE_DIR", "profiles/personal-main");
    let path = std::path::PathBuf::from(&value);
    if path.is_absolute() {
        path
    } else {
        cli::repo_root().join(path)
    }
}

fn find_chrome() -> Option<std::path::PathBuf> {
    let env_lookup = |key: &str| std::env::var(key).ok().filter(|value| !value.is_empty());
    let path = zyquor_browser::find_chrome_executable(&env_lookup);
    if path.exists() {
        Some(path)
    } else if let Ok(bin) = std::env::var("CHROME_BIN") {
        if !bin.is_empty() {
            Some(std::path::PathBuf::from(bin))
        } else {
            None
        }
    } else {
        None
    }
}

pub async fn run_open(manual: bool) -> Result<i32, String> {
    let dir = profile_dir();
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let cdp_url = cli::cdp_url();

    if !manual {
        let up = zyquor_browser::ensure_browser_cdp(&cdp_url, &dir.to_string_lossy()).await;
        if !up {
            eprintln!(
                "Could not ensure Chrome CDP at {cdp_url} for {}",
                dir.display()
            );
            return Ok(1);
        }
        println!("Opened Chrome with CDP on {cdp_url}");
        println!("Profile: {}", dir.display());
        println!("Keep this Chrome window open while Zyquor prepares/posts.");
        return Ok(0);
    }

    let chrome = match find_chrome() {
        Some(path) => path,
        None => {
            eprintln!("Could not find Chrome/Chromium. Set CHROME_BIN=/path/to/chrome and retry.");
            return Ok(1);
        }
    };
    let chrome_config_dir = {
        let value = std::env::var("ZYQUOR_CHROME_CONFIG_DIR")
            .unwrap_or_else(|_| "profiles/chrome-config".to_string());
        let path = std::path::PathBuf::from(&value);
        if path.is_absolute() {
            path
        } else {
            cli::repo_root().join(path)
        }
    };
    std::fs::create_dir_all(&chrome_config_dir).map_err(|error| error.to_string())?;

    let status = std::process::Command::new(&chrome)
        .arg(format!("--user-data-dir={}", dir.display()))
        .arg("--profile-directory=Default")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--no-sandbox")
        .arg("--disable-crash-reporter")
        .arg("--disable-dev-shm-usage")
        .arg("--ozone-platform=x11")
        .arg("https://x.com/login")
        .env("XDG_CONFIG_HOME", &chrome_config_dir)
        .status();
    match status {
        Ok(_) => {}
        Err(error) => {
            eprintln!("Could not launch {}: {error}", chrome.display());
            return Ok(1);
        }
    }
    println!(
        "Opened X login in normal browser with dedicated profile: {}",
        dir.display()
    );
    println!(
        "Log in there, then fully close that browser window before running Zyquor prepare/post."
    );
    println!("Press Enter to finish (the browser will stay open).");
    let stdin = std::io::stdin();
    let mut line = String::new();
    let _ = stdin.lock().read_line(&mut line);
    Ok(0)
}

pub async fn run_check_login() -> Result<i32, String> {
    let dir = profile_dir();
    let dir_string = dir.to_string_lossy().to_string();
    let cdp_url = cli::cdp_url();

    let session = match zyquor_browser::Session::connect(&cdp_url).await {
        Ok(session) => session,
        Err(error) => {
            let value = serde_json::json!({
                "ok": false,
                "profileDir": dir_string,
                "loggedIn": false,
                "handle": null,
                "error": error,
                "hint": "Start `zyquor open-profile` and keep Chrome open, then rerun this check.",
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_default()
            );
            return Ok(1);
        }
    };

    let x_home_url = cli::env_or("ZYQUOR_BROWSER_X_HOME_URL", "https://x.com/home");
    match zyquor_browser::check_x_login(&session, &x_home_url).await {
        Ok(result) => {
            let value = serde_json::json!({
                "ok": result.logged_in,
                "profileDir": dir_string,
                "loggedIn": result.logged_in,
                "handle": result.handle,
                "url": result.url,
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_default()
            );
            if result.logged_in { Ok(0) } else { Ok(1) }
        }
        Err(error) => {
            let value = serde_json::json!({
                "ok": false,
                "profileDir": dir_string,
                "loggedIn": false,
                "handle": null,
                "error": error,
                "hint": "Start `zyquor open-profile` and keep Chrome open, then rerun this check.",
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_default()
            );
            Ok(1)
        }
    }
}
