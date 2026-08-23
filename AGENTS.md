# Project rules

- Never run the Electron desktop app inside WSL. Start it from native Windows instead.
- Codebase lookups go through Graphify before grep/read: `graphify query "<question>"`, `graphify path "A" "B"`, `graphify explain "Symbol"`. Only fall back to grep/read when the graph lacks the answer.
- After structural code changes, refresh the graph: `graphify update . --no-cluster` (zero cost, no API key).
- Local dev ports: 3000 is occupied by an unrelated Next.js app. Run the Zyquor API with `ZYQUOR_API_PORT=3001`, and start the web UI with `ZYQUOR_API_URL=http://127.0.0.1:3001 pnpm --filter @zyquor/web dev` so the `/api` proxy matches.
