//! Single-instance file lock, ported from `acquireWorkerLock` in the
//! TypeScript worker.

use std::path::{Path, PathBuf};

/// Process 0 is never alive, and we never count ourselves as alive.
pub fn pid_is_alive(pid: i64) -> bool {
    if pid <= 0 || pid == std::process::id() as i64 {
        return false;
    }
    let proc_path = format!("/proc/{pid}");
    Path::new(&proc_path).exists()
}

/// `ZYQUOR_WORKER_LOCK_PATH`, else `data/zyquor-worker.lock` under the current
/// directory. The TypeScript resolves the default relative to the source
/// file's repo root; the Rust binary uses the working directory (normally the
/// repo root when launched there).
pub fn default_lock_path() -> PathBuf {
    if let Some(configured) = crate::env::env_var("ZYQUOR_WORKER_LOCK_PATH") {
        if !configured.is_empty() {
            return PathBuf::from(configured);
        }
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join("data").join("zyquor-worker.lock"),
        Err(_) => PathBuf::from("data").join("zyquor-worker.lock"),
    }
}

#[derive(Debug)]
pub struct WorkerLockGuard {
    path: PathBuf,
}

impl Drop for WorkerLockGuard {
    fn drop(&mut self) {
        if let Ok(content) = std::fs::read_to_string(&self.path) {
            if let Ok(pid) = content.trim().parse::<i64>() {
                if pid == std::process::id() as i64 {
                    let _ = std::fs::remove_file(&self.path);
                }
            }
        }
    }
}

/// Acquire the worker lock. Returns `None` (after warning) when another
/// worker holds it or the lock cannot be created.
pub fn acquire_worker_lock(lock_path: &Path) -> Option<WorkerLockGuard> {
    if let Some(parent) = lock_path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            eprintln!(
                "Failed to create worker lock directory {}: {error}",
                parent.display()
            );
            return None;
        }
    }
    if lock_path.exists() {
        let existing = std::fs::read_to_string(lock_path)
            .ok()
            .and_then(|content| content.trim().parse::<i64>().ok());
        let Some(pid) = existing else {
            let _ = std::fs::remove_file(lock_path);
            return create_lock(lock_path);
        };
        if pid_is_alive(pid) {
            eprintln!(
                "Another Zyquor worker is already running with pid {pid}. Exiting duplicate worker."
            );
            return None;
        }
        let _ = std::fs::remove_file(lock_path);
    }
    create_lock(lock_path)
}

fn create_lock(lock_path: &Path) -> Option<WorkerLockGuard> {
    let mut file = match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            eprintln!("Another Zyquor worker acquired the lock first. Exiting duplicate worker.");
            return None;
        }
        Err(error) => {
            eprintln!(
                "Failed to acquire worker lock {}: {error}",
                lock_path.display()
            );
            return None;
        }
    };
    let line = format!("{}\n", std::process::id());
    use std::io::Write;
    if let Err(error) = file.write_all(line.as_bytes()) {
        eprintln!(
            "Failed to write worker lock {}: {error}",
            lock_path.display()
        );
        return None;
    }
    Some(WorkerLockGuard {
        path: lock_path.to_path_buf(),
    })
}
