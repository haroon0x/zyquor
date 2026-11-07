//! Chrome process management for CDP, ported from `ensureBrowserCdp` /
//! `closeBrowserCdp` / `findChromeExecutable` in `packages/browser/src/index.ts`.
//!
//! The module owns every process/env decision: Chrome binary resolution
//! (env override → platform candidates → system default), the spawn
//! arguments (dedicated profile dir, loopback or WSL-exposed debugging port,
//! headless), and the readiness wait loop.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};

use zyquor_core::paths::{EnvLookup, profiles_path};

use crate::launch_state::{
    CdpLaunchState, cdp_launch_state_file, clear_cdp_launch_state_for,
    normalize_stored_profile_dir, read_all_cdp_launch_states, read_cdp_launch_state_for,
    write_cdp_launch_state_for,
};

static ACTIVE_CDP_PIDS: OnceLock<Mutex<HashMap<String, Option<i64>>>> = OnceLock::new();
static ACTIVE_CDP_PROFILE_DIRS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn active_cdp_pids() -> &'static Mutex<HashMap<String, Option<i64>>> {
    ACTIVE_CDP_PIDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn active_cdp_profile_dirs() -> &'static Mutex<HashMap<String, String>> {
    ACTIVE_CDP_PROFILE_DIRS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether the process is running inside WSL (platform + interop marker).
fn is_wsl() -> bool {
    if std::env::consts::OS != "linux" {
        return false;
    }
    Path::new("/proc/sys/fs/binfmt_misc/WSLInterop").exists()
        || std::env::var("WSL_DISTRO_NAME").is_ok()
}

/// Locate the Chrome executable: `ZYQUOR_CHROME_PATH`/`CHROME_BIN` first,
/// then the platform defaults.
pub fn find_chrome_executable(env: EnvLookup<'_>) -> PathBuf {
    let env_path = env("ZYQUOR_CHROME_PATH").or_else(|| env("CHROME_BIN"));
    if let Some(env_path) = env_path {
        let path = PathBuf::from(&env_path);
        if path.exists() {
            return path;
        }
    }

    #[cfg(windows)]
    {
        let local_app_data =
            env("LocalAppData").unwrap_or_else(|| r"C:\Users\user\AppData\Local".to_string());
        let candidates = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ];
        for candidate in candidates {
            let path = PathBuf::from(candidate);
            if path.exists() {
                return path;
            }
        }
        let candidate = PathBuf::from(local_app_data).join(r"Google\Chrome\Application\chrome.exe");
        if candidate.exists() {
            return candidate;
        }
        return PathBuf::from(candidates[0]);
    }
    #[cfg(target_os = "macos")]
    {
        return PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    PathBuf::from("google-chrome-stable")
}

/// The CDP port embedded in `cdp_url`.
pub fn cdp_port(cdp_url: &str) -> Option<u16> {
    url::Url::parse(cdp_url)
        .ok()
        .and_then(|url| url.port_or_known_default())
}

/// Try connecting to an already-running Chrome on `cdp_url`.
async fn try_connect_browser(cdp_url: &str) -> Option<chromiumoxide::browser::Browser> {
    let (browser, _handler) = chromiumoxide::browser::Browser::connect(cdp_url)
        .await
        .ok()?;
    Some(browser)
}

/// Remember a spawned PID for `cdp_url` (and persist its launch state).
fn remember_pid(cdp_url: &str, profile_dir: &str, pid: Option<i64>, port: u16) {
    if let Ok(mut pids) = active_cdp_pids().lock() {
        pids.insert(cdp_url.to_string(), pid);
    }
    if let Ok(mut dirs) = active_cdp_profile_dirs().lock() {
        dirs.insert(cdp_url.to_string(), profile_dir.to_string());
    }
    write_cdp_launch_state_for(
        &cdp_launch_state_file(),
        &CdpLaunchState {
            profile_dir: normalize_stored_profile_dir(profile_dir),
            pid,
            cdp_url: Some(cdp_url.to_string()),
            cdp_port: Some(port),
        },
    );
}

/// Detach so the spawned browser outlives this process (TS `detached: true`).
fn detach(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(not(unix))]
    let _ = command;
}

/// Wait until `cdp_url` answers, up to ~30s. Returns false on timeout or when
/// the spawn already failed.
async fn wait_for_cdp(cdp_url: &str, spawn_failed: bool) -> bool {
    for _ in 0..30 {
        if spawn_failed {
            return false;
        }
        if try_connect_browser(cdp_url).await.is_some() {
            return true;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1_000)).await;
    }
    false
}

/// Ensure a Chrome process is answering at `cdp_url` for `profile_dir`.
/// Returns whether Chrome is up afterwards.
pub async fn ensure_browser_cdp(cdp_url: &str, profile_dir: &str) -> bool {
    let headless = std::env::var("ZYQUOR_BROWSER_HEADLESS").as_deref() == Ok("1");
    let wanted_profile_dir = crate::launch_state::resolve_profile_dir(profile_dir);
    let port = match cdp_port(cdp_url) {
        Some(port) => port,
        None => return false,
    };

    if try_connect_browser(cdp_url).await.is_some() {
        if let Ok(mut dirs) = active_cdp_profile_dirs().lock() {
            dirs.insert(
                cdp_url.to_string(),
                wanted_profile_dir.to_string_lossy().to_string(),
            );
        }
        let pid = active_cdp_pids()
            .lock()
            .ok()
            .and_then(|pids| pids.get(cdp_url).copied().flatten())
            .or_else(|| read_cdp_launch_state_for(profile_dir).and_then(|state| state.pid));
        let state = CdpLaunchState {
            profile_dir: normalize_stored_profile_dir(profile_dir),
            pid,
            cdp_url: Some(cdp_url.to_string()),
            cdp_port: Some(port),
        };
        write_cdp_launch_state_for(&cdp_launch_state_file(), &state);
        return true;
    }

    let read_env = |key: &str| std::env::var(key).ok();

    if is_wsl() {
        if let Some(wsl_base) = read_env("ZYQUOR_WSL_PROFILE_BASE") {
            let profile_name = crate::launch_state::resolve_profile_dir(profile_dir)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| profile_dir.to_string());
            let profile_name = PathBuf::from(&profile_name)
                .to_string_lossy()
                .replace('/', "\\");
            let windows_user_dir = format!(
                "{}\\{}",
                wsl_base
                    .strip_prefix("/mnt/c/")
                    .map(|trimmed| format!("C:\\{trimmed}"))
                    .unwrap_or_else(|| wsl_base.clone()),
                profile_name
            );
            let wsl_user_dir = format!("{wsl_base}/{profile_name}");
            let _ = std::fs::create_dir_all(&wsl_user_dir);

            let headless_arg = if headless {
                "  '--headless=new',\n"
            } else {
                ""
            };
            let script = format!(
                "$chrome = \"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\"\n$chromeArgs = @(\n  '--user-data-dir={windows_user_dir}',\n  '--profile-directory=Default',\n  '--remote-debugging-port={port}',\n  '--remote-debugging-address=0.0.0.0',\n{headless_arg}  '--no-first-run',\n  '--no-default-browser-check',\n  '--no-sandbox',\n  '--disable-dev-shm-usage',\n  'https://x.com/home'\n)\nStart-Process -FilePath $chrome -ArgumentList $chromeArgs\n"
            );
            let ps_path = format!("/tmp/launch-chrome-cdp-{port}.ps1");
            if std::fs::write(&ps_path, &script).is_ok() {
                let ps_path = ps_path.replace("/mnt/c/", "C:\\").replace('/', "\\");
                let mut command = Command::new("powershell.exe");
                command
                    .args(["-ExecutionPolicy", "Bypass", "-File", &ps_path])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                if let Ok(child) = command.spawn() {
                    remember_pid(
                        cdp_url,
                        &wanted_profile_dir.to_string_lossy(),
                        Some(child.id() as i64),
                        port,
                    );
                }
            }
            return wait_for_cdp(cdp_url, false).await;
        }
    }

    // Default: launch the system Chrome locally.
    let chrome_bin = find_chrome_executable(&read_env);
    let chrome_config_dir = match read_env("ZYQUOR_CHROME_CONFIG_DIR") {
        Some(path) => PathBuf::from(path),
        None => profiles_path(["chrome-config"]),
    };
    let _ = std::fs::create_dir_all(&chrome_config_dir);

    let mut command = Command::new(&chrome_bin);
    command
        .arg(format!("--user-data-dir={}", wanted_profile_dir.display()))
        .arg("--profile-directory=Default")
        .arg(format!("--remote-debugging-port={port}"))
        .arg("--remote-debugging-address=127.0.0.1");
    if headless {
        command.arg("--headless=new");
    }
    command
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--no-sandbox")
        .arg("--disable-crash-reporter")
        .arg("--disable-dev-shm-usage");
    #[cfg(not(windows))]
    command.arg("--ozone-platform=x11");
    command
        .arg("https://x.com/home")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("XDG_CONFIG_HOME", chrome_config_dir);
    detach(&mut command);

    let mut spawn_failed = false;
    match command.spawn() {
        Ok(child) => {
            remember_pid(
                cdp_url,
                &wanted_profile_dir.to_string_lossy(),
                Some(child.id() as i64),
                port,
            );
        }
        Err(_) => {
            spawn_failed = true;
        }
    }

    if spawn_failed {
        eprintln!(
            "[browser] failed to launch Chrome via {}; cannot post",
            chrome_bin.display()
        );
    }
    wait_for_cdp(cdp_url, spawn_failed).await
}

/// Shut down the Chrome instance at `cdp_url` and clear its launch state.
pub async fn close_browser_cdp(cdp_url: &str) {
    if let Some(mut browser) = try_connect_browser(cdp_url).await {
        let _ = browser.close().await;
    }

    let pid = active_cdp_pids()
        .lock()
        .ok()
        .and_then(|mut pids| pids.remove(cdp_url));
    if let Some(Some(pid)) = pid {
        kill_pid(pid);
    }

    let profile_dir = active_cdp_profile_dirs()
        .lock()
        .ok()
        .and_then(|mut dirs| dirs.remove(cdp_url));
    if let Some(profile_dir) = profile_dir {
        clear_cdp_launch_state_for(&profile_dir);
    } else if let Some(port) = cdp_port(cdp_url) {
        let states = read_all_cdp_launch_states(&cdp_launch_state_file());
        if let Some(match_state) = states
            .iter()
            .find(|state| state.cdp_port == Some(port) || state.cdp_url.as_deref() == Some(cdp_url))
        {
            clear_cdp_launch_state_for(&match_state.profile_dir);
        }
    }
}

fn kill_pid(pid: i64) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill").arg(pid.to_string()).output();
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
    }
}
