# Project rules

- **Zyquor is a Rust Cargo workspace.** The TypeScript implementation was retired on 2026-11-08; the only non-Rust code left is the React renderer in `apps/web`. Layout: `crates/zyquor-{core,accounts,storage,generation,adapters,automation,browser}` plus `apps/{api,worker,desktop,cli}` and the `apps/web` renderer. `docs/rust-migration.md` is the migration record; `ROADMAP.md` is the current state.
- Do not add new TypeScript packages. UI work happens in `apps/web`; everything else is Rust.
- Rust toolchain: install with `rustup` (stable). Verify with `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`. The web renderer builds with `pnpm --dir apps/web build`.
- Never run the Tauri desktop app inside WSL. Start it from native Windows (`cargo tauri dev`), or use `cargo run -p zyquor-desktop -- --headless-smoke` for a windowless boot check.
- If you have the optional Graphify code-graph tool installed, prefer it over grep/read: `graphify query "<question>"`, `graphify path "A" "B"`, `graphify explain "Symbol"`. Fall back to grep/read otherwise. It is local tooling; `graphify-out/` is gitignored. After structural code changes, refresh the graph with `graphify update . --no-cluster` (zero cost, no API key).
- Local dev ports: the API listens on 3000 by default. If that port is taken, run it with `ZYQUOR_API_PORT=3001` and start the web UI with `ZYQUOR_API_URL=http://127.0.0.1:3001 pnpm --dir apps/web dev` so the Vite `/api` proxy matches.
- Posting is disabled by default. `ZYQUOR_ENABLE_BROWSER_PREPARE=1` / `ZYQUOR_ENABLE_BROWSER_POST=1` enable the browser lanes; enabling them, or running the reply/post loops, requires an explicit human ask. Failed external post jobs are never auto-retried.
- Each X account runs on its own Chrome profile and its own remote-debugging port under `profiles/<handle>`. Jobs for different accounts run at the same time; there is no one-account-at-a-time limit. `posting-chrome.json` keeps one small record per profile, not one record for the whole app. Each account still has its own limits: daily post limit, quiet hours, gap between posts, and one running browser job at a time for that account.
- Persistence is SQLite only (rusqlite); there is no JSON fallback.
- License: AGPL-3.0-only.
