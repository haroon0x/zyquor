//! Shared spawn/capture logic for the CLI-backed providers, ported from the
//! duplicated bodies of `runCommandCode` and `runOpencode`.
//!
//! Behaviour kept identical to TypeScript: a dedicated working directory (the
//! system temp dir), the filtered `provider_process_env`, a combined stdout +
//! stderr byte cap that kills the child, and a wall-clock timeout. The Windows
//! `.cmd`-shim behaviour (`shell: true`) is reproduced via `cmd /C`.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::types::{GenerationRequestError, GenerationResult};

use super::cli_env::provider_process_env;

/// Captured output of a finished CLI run, stdout/stderr as UTF-8 lossy text
/// with leading/trailing whitespace trimmed (as TypeScript trims on use).
pub struct CliOutput {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

fn base_command(command: &str) -> Command {
    #[cfg(windows)]
    {
        let mut process = Command::new("cmd");
        process.arg("/C").arg(command);
        // CREATE_NO_WINDOW: keep console windows from flashing on Windows.
        process.creation_flags(0x0800_0000);
        process
    }
    #[cfg(not(windows))]
    {
        Command::new(command)
    }
}

/// Spawn the CLI, feed `stdin_text` on stdin, and capture stdout/stderr.
///
/// `label` is the human name used in error messages ("Command Code" /
/// "Opencode"); `not_found_hint` completes the "CLI was not found" message.
pub async fn run_cli(
    command: &str,
    args: &[&str],
    stdin_text: &str,
    timeout_ms: u64,
    max_output_bytes: usize,
    label: &str,
    not_found_hint: &str,
) -> GenerationResult<CliOutput> {
    let mut process = base_command(command);
    process
        .args(args)
        .current_dir(std::env::temp_dir())
        .env_clear()
        .envs(provider_process_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => {
            if error.kind() == std::io::ErrorKind::NotFound {
                return Err(GenerationRequestError::configuration(format!(
                    "{label} CLI was not found at \"{command}\". {not_found_hint}"
                )));
            }
            return Err(GenerationRequestError::transport(format!(
                "{label} failed to start: {error}"
            )));
        }
    };

    // Prompt goes to stdin; a broken pipe (child exited early) is ignored,
    // exactly like the TypeScript `child.stdin.on("error", ...)` swallow.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(stdin_text.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }

    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let mut stdout_buf: Vec<u8> = Vec::new();
    let mut stderr_buf: Vec<u8> = Vec::new();
    let mut stdout_chunk = [0_u8; 16 * 1024];
    let mut stderr_chunk = [0_u8; 16 * 1024];
    let mut stdout_done = stdout.is_none();
    let mut stderr_done = stderr.is_none();
    let mut output_bytes = 0_usize;
    let deadline = tokio::time::sleep(Duration::from_millis(timeout_ms));
    tokio::pin!(deadline);

    let read_outcome = loop {
        tokio::select! {
            result = async {
                match stdout.as_mut() {
                    Some(reader) => reader.read(&mut stdout_chunk).await,
                    None => std::future::pending().await,
                }
            } => {
                match result {
                    Ok(0) | Err(_) => stdout_done = true,
                    Ok(read) => {
                        output_bytes += read;
                        if output_bytes > max_output_bytes {
                            let _ = child.kill().await;
                            break Err(format!("{label} generation exceeded the output limit"));
                        }
                        stdout_buf.extend_from_slice(&stdout_chunk[..read]);
                    }
                }
            }
            result = async {
                match stderr.as_mut() {
                    Some(reader) => reader.read(&mut stderr_chunk).await,
                    None => std::future::pending().await,
                }
            } => {
                match result {
                    Ok(0) | Err(_) => stderr_done = true,
                    Ok(read) => {
                        output_bytes += read;
                        if output_bytes > max_output_bytes {
                            let _ = child.kill().await;
                            break Err(format!("{label} generation exceeded the output limit"));
                        }
                        stderr_buf.extend_from_slice(&stderr_chunk[..read]);
                    }
                }
            }
            () = &mut deadline => {
                let _ = child.kill().await;
                break Err(format!("{label} generation timed out after {timeout_ms}ms"));
            }
            status = child.wait(), if stdout_done && stderr_done => {
                break Ok(status);
            }
        }
    };

    match read_outcome {
        Ok(Ok(status)) => Ok(CliOutput {
            code: status.code(),
            stdout: String::from_utf8_lossy(&stdout_buf).trim().to_string(),
            stderr: String::from_utf8_lossy(&stderr_buf).trim().to_string(),
        }),
        Ok(Err(error)) => Err(GenerationRequestError::transport(format!(
            "{label} failed to start: {error}"
        ))),
        Err(message) => Err(GenerationRequestError::transport(message)),
    }
}

/// UTC timestamp formatted like `2026-11-06T13-12-33-123Z` (TypeScript
/// `new Date().toISOString().replace(/[:.]/g, "-")`), without a date dependency.
fn iso_millis_stamp(now: std::time::SystemTime) -> String {
    let since_epoch = now
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    let total_millis = since_epoch.as_millis() as u64;
    let millis = total_millis % 1000;
    let total_secs = total_millis / 1000;
    let hour = (total_secs / 3600) % 24;
    let minute = (total_secs / 60) % 60;
    let second = total_secs % 60;

    // Howard Hinnant's civil_from_days algorithm.
    let days = (total_secs / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let mp = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }

    format!("{year:04}-{month:02}-{day:02}T{hour:02}-{minute:02}-{second:02}-{millis:03}Z")
}

/// Audit hook: with `ZYQUOR_LLM_DEBUG=1`, drop the exact prompt and the raw
/// model output into `data/artifacts/`. Best-effort; failures never fail the
/// generation (same posture as the TypeScript `try/catch` around the writes).
pub fn maybe_write_llm_debug(prompt: &str, output: &str) {
    if std::env::var("ZYQUOR_LLM_DEBUG").as_deref() != Ok("1") {
        return;
    }
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    let dir = cwd.join("data").join("artifacts");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let stamp = iso_millis_stamp(std::time::SystemTime::now());
    let _ = std::fs::write(dir.join(format!("llm-input-{stamp}.txt")), prompt);
    let _ = std::fs::write(dir.join(format!("llm-output-{stamp}.txt")), output);
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn iso_stamp_matches_expected_shape() {
        let stamp =
            iso_millis_stamp(std::time::UNIX_EPOCH + Duration::from_millis(1_762_919_553_123));
        // Shape: YYYY-MM-DDTHH-MM-SS-mmmZ
        assert_eq!(stamp.len(), 24);
        assert!(stamp.ends_with('Z'));
        assert_eq!(stamp.chars().filter(|c| *c == '-').count(), 5);
    }
}
