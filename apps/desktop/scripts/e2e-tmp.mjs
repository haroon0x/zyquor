// Temporary end-to-end check of the automated lane against a scratch data root.
// Posting is hard-disabled at the API, so the final post click can never fire.
const DATA_ROOT = process.env.ZYQUOR_DATA_ROOT ?? "/tmp/zyq-e2e";
process.env.ZYQUOR_DATA_ROOT = DATA_ROOT;
process.env.ZYQUOR_WORKER_LOCK_PATH = `${DATA_ROOT}/worker.lock`;
const { loadDotEnv } = await import("@zyquor/core");
loadDotEnv();

const RUN_MINUTES = Number(process.env.RUN_MINUTES ?? 15);

const { ensureFirstRun } = await import("@zyquor/storage");
ensureFirstRun(DATA_ROOT);

const { buildApp } = await import("@zyquor/api");
const { startWorker } = await import("@zyquor/worker");

const api = buildApp({ enableBrowserPrepare: false, enableBrowserPost: false, closeAfterPrepare: true, closeAfterPost: true });
api.log.level = "warn";
await api.listen({ host: "127.0.0.1", port: 0 });
const url = `http://127.0.0.1:${api.server.address().port}`;
const get = async (p) => (await fetch(`${url}${p}`)).json();
const post = async (p, body) =>
  (await fetch(`${url}${p}`, { method: "POST", ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) })).json();

console.log("health:", JSON.stringify(await get("/health")));

if (((await get("/ingest-configs")).configs ?? []).length === 0) {
  const seeded = await post("/ingest-configs/default-news");
  console.log("seeded ingest config:", seeded.config?.id ?? JSON.stringify(seeded));
}

const worker = startWorker({ apiUrl: url, autoSeedDefaultIngest: true, ingestIntervalMs: 60_000, pollMs: 5000 });

const deadline = Date.now() + RUN_MINUTES * 60_000;
let tick = 0;
let done = false;
const seen = new Set();
while (Date.now() < deadline && !done) {
  await new Promise((r) => setTimeout(r, 20_000));
  tick += 1;
  const status = await get("/system/status");
  const packets = (await get("/source-packets")).packets ?? [];
  const jobs = (await get("/jobs")).jobs ?? [];
  const run = status.ingestRun ?? {};
  console.log(
    `[t+${tick * 20}s] running=${run.running} processed=${run.processed} errors=${(run.errors ?? []).length} skips=${JSON.stringify(run.skippedByReason ?? {})} packets=${packets.length}(${packets.map((p) => p.status).join(",")}) jobs=${jobs.length} ${JSON.stringify(status.counts.jobsByStatus)}`
  );
  const firstError = (run.errors ?? [])[0];
  if (firstError) console.log(`  first ingest error: ${firstError.error}`);

  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    const d = await get(`/drafts/${job.draftId}`);
    const text = d.draft?.editedText ?? null;
    console.log(`  JOB ${job.id.slice(0, 8)} status=${job.status} scheduledFor=${job.scheduledFor}`);
    console.log(`  DRAFT: ${text}`);
  }
  if (seen.size >= 3) done = true;
}

console.log(done ? "=== PIPELINE REACHED AN APPROVED JOB ===" : "=== NO JOB PRODUCED IN WINDOW ===");
const final = await get("/system/status");
console.log("worker:", JSON.stringify(final.worker));
console.log("posting:", JSON.stringify(final.posting));
await worker.stop();
await api.close();
process.exit(0);
