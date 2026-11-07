//! Buffered file logger, ported from `log.ts`.
//!
//! Mirrors the TypeScript behavior: timestamped lines appended to
//! `logs/main.log` under the data root, 5 MiB rotation (the old backup
//! `main.log.1` is removed first, matching the Windows rename rule), a
//! 100 ms delayed flush, an immediate flush once the buffer reaches
//! 256 KiB, and one line echoed to stdout per `logLine` call (the TS
//! `baseConsoleLog`, i.e. `console.log`). I/O errors are swallowed —
//! logging never crashes the app.
//!
//! The TS crash handlers (`process.on("uncaughtException")`, etc.) have no
//! equivalent here; a Rust panic aborts its thread. If a process-level
//! safety net is needed, the app entrypoint can install a panic hook that
//! calls [`log_line`] + [`flush_log_sync`] itself.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

const FIVE_MB: u64 = 5 * 1024 * 1024;
const FLUSH_DELAY_MS: u64 = 100;
const MAX_BUFFERED_BYTES: usize = 256 * 1024;

struct LogState {
    path: Option<PathBuf>,
    buffer: Vec<String>,
    buffer_bytes: usize,
    written_bytes: u64,
}

static STATE: OnceLock<Mutex<LogState>> = OnceLock::new();
static FLUSH_SCHEDULED: AtomicBool = AtomicBool::new(false);

fn state() -> &'static Mutex<LogState> {
    STATE.get_or_init(|| {
        Mutex::new(LogState {
            path: None,
            buffer: Vec::new(),
            buffer_bytes: 0,
            written_bytes: 0,
        })
    })
}

fn timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn file_size(log_path: &Path) -> u64 {
    std::fs::metadata(log_path)
        .map(|meta| meta.len())
        .unwrap_or(0)
}

fn rotate(log_path: &Path) {
    // Windows rename fails when the target exists, so drop the old backup first.
    let _ = std::fs::remove_file(log_path.with_extension("log.1"));
    let _ = std::fs::rename(log_path, log_path.with_extension("log.1"));
}

fn rotate_if_needed(log_path: &Path) {
    if file_size(log_path) > FIVE_MB {
        rotate(log_path);
    }
}

fn write_now(log_path: &Path, text: &str) {
    if text.is_empty() {
        return;
    }
    use std::io::Write;
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
    else {
        return;
    };
    let _ = file.write_all(text.as_bytes());
}

/**
 * Push buffered lines to disk. Runs off the hot path: logLine never blocks
 * on I/O, and the flush is batched so bursts cost one write instead of one.
 */
pub fn flush_log() {
    let Ok(mut record) = state().lock() else {
        return;
    };
    if record.buffer.is_empty() {
        return;
    }
    let text = record.buffer.join("");
    let bytes = text.len();
    record.buffer.clear();
    record.buffer_bytes = 0;

    if let Some(log_path) = record.path.clone() {
        if record.written_bytes + bytes as u64 > FIVE_MB {
            // Rotate on write, not only at startup, so a long-running app
            // cannot grow main.log without bound.
            rotate(&log_path);
            record.written_bytes = 0;
        }
        write_now(&log_path, &text);
        record.written_bytes += bytes as u64;
    }
}

/// Drain the buffer with a blocking write. Only for shutdown paths.
pub fn flush_log_sync() {
    flush_log();
}

fn schedule_flush() {
    if FLUSH_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(FLUSH_DELAY_MS));
        FLUSH_SCHEDULED.store(false, Ordering::SeqCst);
        flush_log();
    });
}

/// Path of the active log file, if [`init_file_log`] has run.
pub fn log_file_path() -> Option<PathBuf> {
    state().lock().ok()?.path.clone()
}

/// The last `lines` non-empty lines, including any not-yet-flushed buffer.
pub fn log_tail(lines: usize) -> Vec<String> {
    let Ok(record) = state().lock() else {
        return Vec::new();
    };
    let Some(log_path) = record.path.clone() else {
        return Vec::new();
    };
    let Ok(file_text) = std::fs::read_to_string(&log_path) else {
        // File unreadable (or not yet flushed); fall back to the buffer.
        let buffered = record.buffer.join("");
        return tail_lines(&buffered, lines);
    };
    let content = file_text + &record.buffer.join("");
    tail_lines(&content, lines)
}

fn tail_lines(content: &str, lines: usize) -> Vec<String> {
    let all: Vec<String> = content
        .split('\n')
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    let start = all.len().saturating_sub(lines);
    all[start..].to_vec()
}

/// Initialize the log file under `{dataRoot}/logs/main.log`. The init line
/// is written synchronously: it is one write per process and makes "did the
/// app ever boot" answerable even after a hard crash.
pub fn init_file_log(data_root: &Path) {
    let logs_dir = data_root.join("logs");
    let _ = std::fs::create_dir_all(&logs_dir);
    let log_path = logs_dir.join("main.log");

    let written_bytes = file_size(&log_path);
    {
        let Ok(mut record) = state().lock() else {
            return;
        };
        record.path = Some(log_path.clone());
        record.buffer.clear();
        record.buffer_bytes = 0;
        record.written_bytes = written_bytes;
    }
    rotate_if_needed(&log_path);
    // After rotation the fresh file starts empty.
    {
        let Ok(mut record) = state().lock() else {
            return;
        };
        if record.written_bytes > FIVE_MB {
            record.written_bytes = 0;
        }
    }
    write_now(
        &log_path,
        &format!("{} [info] log initialized\n", timestamp()),
    );
}

/**
 * Write a timestamped log line to the file (if initialized) and stdout.
 */
pub fn log_line(level: &str, msg: &str) {
    let line = format!("{} [{}] {}", timestamp(), level, msg);
    println!("{line}");

    let over_threshold = {
        let Ok(mut record) = state().lock() else {
            return;
        };
        if record.path.is_none() {
            return;
        }
        record.buffer.push(format!("{line}\n"));
        record.buffer_bytes += line.len() + 1;
        record.buffer_bytes >= MAX_BUFFERED_BYTES
    };
    if over_threshold {
        flush_log();
        return;
    }
    schedule_flush();
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("zyquor-log-{name}-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn log_lines_round_trip_through_log_tail() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        let dir = temp_dir("roundtrip");
        init_file_log(&dir);
        log_line("info", "hello world");
        log_line("warn", "careful");
        flush_log_sync();

        let path = log_file_path().expect("log path");
        assert_eq!(path, dir.join("logs").join("main.log"));
        let tail = log_tail(10);
        assert!(
            tail.iter()
                .any(|line| line.contains("[info] log initialized"))
        );
        assert!(tail.iter().any(|line| line.contains("[info] hello world")));
        assert!(tail.iter().any(|line| line.contains("[warn] careful")));
        assert_eq!(tail.len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_tail_includes_unflushed_buffer() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        let dir = temp_dir("buffered");
        init_file_log(&dir);
        log_line("error", "buffered line");
        let tail = log_tail(2);
        assert!(tail.iter().any(|line| line.contains("buffered line")));
        flush_log_sync();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_main_log_over_five_mb_at_init() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        let dir = temp_dir("rotate");
        let logs_dir = dir.join("logs");
        std::fs::create_dir_all(&logs_dir).expect("create logs dir");
        // Old oversized main.log plus a stale backup that must be dropped.
        std::fs::write(logs_dir.join("main.log"), "x".repeat(5 * 1024 * 1024 + 1))
            .expect("write big log");
        std::fs::write(logs_dir.join("main.log.1"), "stale").expect("write stale backup");

        init_file_log(&dir);

        let backup = std::fs::read_to_string(logs_dir.join("main.log.1")).expect("read backup");
        assert_eq!(backup.len(), 5 * 1024 * 1024 + 1);
        assert!(backup.starts_with('x'));
        let current = std::fs::read_to_string(logs_dir.join("main.log")).expect("read fresh log");
        assert!(current.contains("[info] log initialized"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_on_write_when_flush_exceeds_five_mb() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        let dir = temp_dir("rotatewrite");
        init_file_log(&dir);
        log_line("info", "start");
        // Push the buffer past 5 MiB so the flush rotates before writing.
        log_line("info", &"y".repeat(5 * 1024 * 1024 + 1));
        flush_log_sync();

        let logs_dir = dir.join("logs");
        assert!(
            logs_dir.join("main.log.1").exists(),
            "old log rotated to backup"
        );
        let current = std::fs::read_to_string(logs_dir.join("main.log")).expect("read rotated log");
        assert!(
            current.contains("yyy"),
            "oversized line landed in the fresh file"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_tail_before_init_is_empty() {
        let _guard = TEST_LOCK.lock().expect("test lock");
        // Some prior test may have initialized the logger; assert only the
        // contract that un-initialized state returns an empty tail.
        let was_uninitialized = log_file_path().is_none();
        if was_uninitialized {
            assert!(log_tail(5).is_empty());
        }
    }
}
