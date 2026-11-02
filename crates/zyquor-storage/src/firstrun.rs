//! Ported from `packages/storage/src/firstrun.ts`.

use std::io;
use std::path::Path;

/// Creates `data/artifacts` and `profiles/personal-main` under `data_root`.
/// Idempotent.
pub fn ensure_first_run(data_root: impl AsRef<Path>) -> io::Result<()> {
    let root = data_root.as_ref();
    std::fs::create_dir_all(root.join("data").join("artifacts"))?;
    std::fs::create_dir_all(root.join("profiles").join("personal-main"))?;
    Ok(())
}
