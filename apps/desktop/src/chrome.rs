//! Posting Chrome lifecycle, ported from `chrome.ts`.
//!
//! Responsibilities of this module:
//! - `find_chrome()` EXE resolution per platform (`ZYQUOR_CHROME_PATH` env
//!   first, then the platform candidates from the TS original).
//! - `is_cdp_up()` readiness probe (GET `{cdpUrl}/json/version`, 2 s timeout).
//! - `launch_posting_chrome()` / `close_posting_chrome()` orchestration:
//!   already-running / port-busy checks, dedicated profile-dir validation,
//!   then delegation to [`zyquor_browser::ensure_browser_cdp`] /
//!   [`zyquor_browser::close_browser_cdp`]. Chrome spawn args and the
//!   `posting-chrome.json` per-profile state record are owned by
//!   `zyquor_browser::launch_state` (same file path, legacy single-record
//!   shape read-compatible), so this module does not spawn Chrome itself.
//! - `cdp_port_for_profile()` derives the per-profile CDP port from the
//!   shared path helper.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use zyquor_accounts::assert_dedicated_profile_dir;
use zyquor_browser::launch_state::{
    clear_cdp_launch_state_for, read_all_cdp_launch_states, read_cdp_launch_state_for,
};
use zyquor_browser::{close_browser_cdp, ensure_browser_cdp};
use zyquor_core::paths::{per_profile_cdp_url, resolve_absolute};

const CDP_POLL_INTERVAL_MS: u64 = 500;
const CDP_POLL_TIMEOUT_MS: u64 = 15_000;
const CDP_PORT_FREE_TIMEOUT_MS: u64 = 3_000;

/// Outcome of [`launch_posting_chrome`]. `reason` is set when
/// `launched` is `false` (`"already-running"`, `"cdp-port-busy"`,
/// `"chrome-not-found"`, `"cdp-timeout"`, or a profile-dir error message).
#[derive(Debug, Clone)]
pub struct LaunchResult {
    pub launched: bool,
    pub reason: Option<String>,
}

/// Outcome of [`close_posting_chrome`]. `reason` is set when
/// `closed` is `false` (`"not-running"`, `"still-running"`).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseResult {
    pub closed: bool,
    pub reason: Option<String>,
}

fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// Locate the Chrome executable. A set-but-missing `ZYQUOR_CHROME_PATH`
/// yields `None` (no fall-through), matching the TS original.
pub fn find_chrome() -> Option<PathBuf> {
    find_chrome_with_env(&process_env)
}

fn find_chrome_with_env(env: zyquor_core::paths::EnvLookup<'_>) -> Option<PathBuf> {
    if let Some(env_path) = env("ZYQUOR_CHROME_PATH") {
        let path = PathBuf::from(&env_path);
        return if path.exists() { Some(path) } else { None };
    }

    #[cfg(windows)]
    {
        let program_files = env("ProgramFiles").unwrap_or_else(|| r"C:\Program Files".to_string());
        let program_files_x86 =
            env("ProgramFiles(x86)").unwrap_or_else(|| r"C:\Program Files (x86)".to_string());
        let username = env("USERNAME").unwrap_or_else(|| "user".to_string());
        let local_app_data =
            env("LocalAppData").unwrap_or_else(|| format!(r"C:\Users\{username}\AppData\Local"));
        let candidates = [
            PathBuf::from(&program_files).join(r"Google\Chrome\Application\chrome.exe"),
            PathBuf::from(&program_files_x86).join(r"Google\Chrome\Application\chrome.exe"),
            PathBuf::from(&local_app_data).join(r"Google\Chrome\Application\chrome.exe"),
        ];
        for candidate in candidates {
            if candidate.exists() {
                return Some(candidate);
            }
        }
        return None;
    }

    #[cfg(not(windows))]
    {
        if let Some(chrome_bin) = env("CHROME_BIN") {
            let path = PathBuf::from(&chrome_bin);
            if path.exists() {
                return Some(path);
            }
        }
        let linux_candidates = [
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/usr/local/bin/google-chrome-stable",
            "/usr/local/bin/google-chrome",
            "/snap/bin/google-chrome-stable",
            "/snap/bin/google-chrome-enterprise",
        ];
        for candidate in linux_candidates {
            let path = PathBuf::from(candidate);
            if path.exists() {
                return Some(path);
            }
        }
        None
    }
}

static HTTP_CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();

fn http_client() -> Option<reqwest::Client> {
    HTTP_CLIENT
        .get_or_init(|| reqwest::Client::builder().build().ok())
        .clone()
}

/// Whether a Chrome DevTools endpoint answers at `cdp_url`
/// (GET `{cdpUrl}/json/version`, 2 s timeout).
pub async fn is_cdp_up(cdp_url: &str) -> bool {
    let Some(client) = http_client() else {
        return false;
    };
    let url = format!("{cdp_url}/json/version");
    let response = tokio::time::timeout(Duration::from_secs(2), client.get(&url).send()).await;
    matches!(response, Ok(Ok(resp)) if resp.status().is_success())
}

static LAUNCHING_PORTS: OnceLock<Mutex<HashSet<u16>>> = OnceLock::new();

fn launching_ports() -> &'static Mutex<HashSet<u16>> {
    LAUNCHING_PORTS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Serialize concurrent launches per CDP port (the TS `launchQueues`).
async fn acquire_port(port: u16) {
    loop {
        let taken = launching_ports()
            .lock()
            .map(|mut ports| ports.insert(port))
            .unwrap_or(false);
        if taken {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn release_port(port: u16) {
    if let Ok(mut ports) = launching_ports().lock() {
        ports.remove(&port);
    }
}

fn occupancy_pid(cdp_port: u16) -> Option<i64> {
    let path = zyquor_browser::launch_state::cdp_launch_state_file();
    read_all_cdp_launch_states(&path)
        .into_iter()
        .find(|state| state.cdp_port == Some(cdp_port))
        .and_then(|state| state.pid)
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

async fn wait_until_cdp_down(cdp_url: &str, timeout_ms: u64) -> bool {
    let start = tokio::time::Instant::now();
    while start.elapsed() < Duration::from_millis(timeout_ms) {
        if !is_cdp_up(cdp_url).await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(CDP_POLL_INTERVAL_MS)).await;
    }
    !is_cdp_up(cdp_url).await
}

/// Launch a posting Chrome for `profile_dir` on `cdp_port`, mirroring
/// `launchPostingChrome`. The spawn args and the `posting-chrome.json`
/// record are handled inside [`ensure_browser_cdp`]; this function owns
/// the already-running / port-busy checks and the readiness wait.
pub async fn launch_posting_chrome(profile_dir: &Path, cdp_port: u16) -> LaunchResult {
    acquire_port(cdp_port).await;
    let result = launch_posting_chrome_inner(profile_dir, cdp_port).await;
    release_port(cdp_port);
    result
}

async fn launch_posting_chrome_inner(profile_dir: &Path, cdp_port: u16) -> LaunchResult {
    let cdp_url = format!("http://127.0.0.1:{cdp_port}");

    if is_cdp_up(&cdp_url).await {
        let profile_dir_string = profile_dir.to_string_lossy().to_string();
        let state = read_cdp_launch_state_for(&profile_dir_string);
        if let Some(state) = &state {
            if resolve_absolute(&state.profile_dir) == resolve_absolute(profile_dir) {
                return LaunchResult {
                    launched: false,
                    reason: Some("already-running".to_string()),
                };
            }
        }
        let stale_pid = occupancy_pid(cdp_port).or_else(|| state.and_then(|s| s.pid));
        if let Some(pid) = stale_pid {
            kill_pid(pid);
        }
        if !wait_until_cdp_down(&cdp_url, CDP_PORT_FREE_TIMEOUT_MS).await {
            return LaunchResult {
                launched: false,
                reason: Some("cdp-port-busy".to_string()),
            };
        }
    }

    let profile_dir_string = profile_dir.to_string_lossy().to_string();
    if let Err(err) = assert_dedicated_profile_dir(&profile_dir_string) {
        return LaunchResult {
            launched: false,
            reason: Some(err.to_string()),
        };
    }

    if find_chrome().is_none() {
        return LaunchResult {
            launched: false,
            reason: Some("chrome-not-found".to_string()),
        };
    }

    let up = ensure_browser_cdp(&cdp_url, &profile_dir_string).await;
    if up {
        return LaunchResult {
            launched: true,
            reason: None,
        };
    }

    // ensure_browser_cdp already polls internally; also wait up to 15 s in
    // 500 ms polls, mirroring the TS post-spawn readiness loop.
    let start = tokio::time::Instant::now();
    while start.elapsed() < Duration::from_millis(CDP_POLL_TIMEOUT_MS) {
        if is_cdp_up(&cdp_url).await {
            return LaunchResult {
                launched: true,
                reason: None,
            };
        }
        tokio::time::sleep(Duration::from_millis(CDP_POLL_INTERVAL_MS)).await;
    }
    LaunchResult {
        launched: false,
        reason: Some("cdp-timeout".to_string()),
    }
}

/// Shut down the posting Chrome on `cdp_port` via
/// [`close_browser_cdp`], wait until the endpoint stops answering, then
/// drop its `posting-chrome.json` record.
pub async fn close_posting_chrome(cdp_port: u16) -> CloseResult {
    let cdp_url = format!("http://127.0.0.1:{cdp_port}");
    if !is_cdp_up(&cdp_url).await {
        clear_state_for_port(cdp_port);
        return CloseResult {
            closed: false,
            reason: Some("not-running".to_string()),
        };
    }

    close_browser_cdp(&cdp_url).await;
    let stopped = wait_until_cdp_down(&cdp_url, CDP_POLL_TIMEOUT_MS).await;
    clear_state_for_port(cdp_port);
    if stopped {
        CloseResult {
            closed: true,
            reason: None,
        }
    } else {
        CloseResult {
            closed: false,
            reason: Some("still-running".to_string()),
        }
    }
}

fn clear_state_for_port(cdp_port: u16) {
    let path = zyquor_browser::launch_state::cdp_launch_state_file();
    for state in read_all_cdp_launch_states(&path) {
        if state.cdp_port == Some(cdp_port) {
            clear_cdp_launch_state_for(&state.profile_dir);
        }
    }
}

/// The PID of the first posting-Chrome launch recorded in
/// `posting-chrome.json` (replacing the TS in-memory `launchedChromePids`
/// map, per the M6 decision at the coordinator: state is read from disk).
pub fn launched_posting_chrome_pid() -> Option<u32> {
    let state = zyquor_browser::read_cdp_launch_state()?;
    let pid = state.pid?;
    u32::try_from(pid).ok()
}

/// The CDP port for `profile_dir` under `base_cdp_url`, via the shared
/// per-profile URL derivation (base-port profiles on the base port,
/// `willainotice` on base+1, anything else on a stable hash offset).
pub fn cdp_port_for_profile(profile_dir: &str, base_cdp_url: &str) -> u16 {
    let url = per_profile_cdp_url(Some(base_cdp_url), profile_dir);
    zyquor_browser::launcher::cdp_port(&url).unwrap_or(9222)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup<'a>(map: &'a HashMap<&'a str, &'a str>) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| map.get(key).map(|value| (*value).to_string())
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("zyquor-chrome-{name}-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn find_chrome_uses_env_path_when_it_exists() {
        let dir = temp_dir("envhit");
        let chrome = dir.join("chrome-fixture");
        std::fs::write(&chrome, "fake").expect("write fixture");
        let map: HashMap<&str, &str> =
            HashMap::from([("ZYQUOR_CHROME_PATH", chrome.to_str().expect("utf8"))]);
        let found = find_chrome_with_env(&lookup(&map));
        assert_eq!(found, Some(chrome.clone()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_chrome_returns_none_when_env_path_is_missing() {
        let map: HashMap<&str, &str> =
            HashMap::from([("ZYQUOR_CHROME_PATH", "/zyquor-definitely-not-a-chrome")]);
        let found = find_chrome_with_env(&lookup(&map));
        assert_eq!(found, None);
    }

    #[tokio::test]
    async fn is_cdp_up_false_for_closed_port() {
        assert!(!is_cdp_up("http://127.0.0.1:1").await);
    }

    #[tokio::test]
    async fn is_cdp_up_true_for_live_endpoint() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind listener");
        let port = listener.local_addr().expect("local addr").port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::{Read, Write};
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
            }
        });
        let cdp_url = format!("http://127.0.0.1:{port}");
        assert!(is_cdp_up(&cdp_url).await);
    }

    #[test]
    fn posting_chrome_state_json_reads_legacy_and_map_shapes() {
        let dir = temp_dir("states");
        let legacy_path = dir.join("legacy.json");
        std::fs::write(
            &legacy_path,
            r#"{"profileDir": "/data/profiles/alice", "pid": 123, "cdpPort": 9223}"#,
        )
        .expect("write legacy");
        let legacy = read_all_cdp_launch_states(&legacy_path);
        assert_eq!(legacy.len(), 1);
        assert_eq!(legacy[0].pid, Some(123));
        assert_eq!(legacy[0].cdp_port, Some(9223));

        let map_path = dir.join("map.json");
        std::fs::write(
            &map_path,
            r#"{"alice": {"profileDir": "/data/profiles/alice", "pid": 123, "cdpPort": 9223}, "bob": {"profileDir": "/data/profiles/bob", "pid": null, "cdpPort": 9224}}"#,
        )
        .expect("write map");
        let map = read_all_cdp_launch_states(&map_path);
        assert_eq!(map.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cdp_port_for_profile_derives_expected_ports() {
        assert_eq!(
            cdp_port_for_profile("profiles/personal-main", "http://127.0.0.1:9300"),
            9300
        );
        assert_eq!(
            cdp_port_for_profile("profiles/willainotice", "http://127.0.0.1:9300"),
            9301
        );
        let port = cdp_port_for_profile("profiles/someone-else", "http://127.0.0.1:9300");
        assert!(
            (9300..=9309).contains(&port),
            "hash offset within 0..=9: {port}"
        );
    }
}
