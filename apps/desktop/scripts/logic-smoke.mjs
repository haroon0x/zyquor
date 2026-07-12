// Standalone smoke test that exercises the same logic paths as the Electron smoke
// but without requiring the electron binary. Verifies:
// - @zyquor/api's buildApp can be imported and booted
// - @zyquor/worker's startWorker can be imported and started
// - API responds to /accounts and /worker/status with 200

const apiUrl = `http://127.0.0.1:${process.env.ZYQUOR_API_PORT ?? 0}`;

async function main() {
  process.env.ZYQUOR_DATA_ROOT = process.env.ZYQUOR_DATA_ROOT ?? "/tmp/zyq-desktop-smoke";

  const { ensureFirstRun, detectSqliteSupport } = await import("@zyquor/storage");
  ensureFirstRun(process.env.ZYQUOR_DATA_ROOT);

  const sqliteCheck = await detectSqliteSupport();
  if (sqliteCheck.available) {
    console.log("storage: node:sqlite available");
  } else {
    console.warn(`storage: node:sqlite unavailable (${sqliteCheck.error}) — falling back to JSON file storage`);
  }

  const { buildApp } = await import("@zyquor/api");
  const { startWorker } = await import("@zyquor/worker");

  const api = buildApp({
    enableBrowserPrepare: false,
    enableBrowserPost: false,
    closeAfterPrepare: true,
    closeAfterPost: true,
  });

  await api.listen({ host: "127.0.0.1", port: 0 });
  const address = api.server.address();
  if (!address || typeof address === "string") throw new Error("Failed to get port");
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;

  const workerHandle = startWorker({
    apiUrl: url,
    autoSeedDefaultIngest: false,
    ingestIntervalMs: 60_000,
    pollMs: 60_000,
  });

  await new Promise((resolve) => setTimeout(resolve, 800));

  let ok = true;
  for (const path of ["/accounts", "/worker/status"]) {
    try {
      const res = await fetch(`${url}${path}`);
      if (res.status !== 200) {
        console.error(`FAIL: ${path} returned ${res.status}`);
        ok = false;
      } else {
        console.log(`OK: ${path} → 200`);
      }
    } catch (err) {
      console.error(`FAIL: ${path} fetch error:`, err instanceof Error ? err.message : err);
      ok = false;
    }
  }

  // Idle RSS and lazy-browser evidence
  const idleRssMB = Math.round((process.memoryUsage().rss / (1024 * 1024)) * 100) / 100;
  console.log(`idle RSS: ${idleRssMB} MB`);

  // Check browser was never loaded (lazy import evidence)
  try {
    const healthRes2 = await fetch(`${url}/health`);
    const healthJson2 = await healthRes2.json();
    if (healthJson2.browserLoaded === false) {
      console.log("lazy-browser OK: @zyquor/browser not loaded at idle");
    } else {
      console.warn("lazy-browser WARN: @zyquor/browser was loaded at idle");
    }
  } catch {
    console.warn("lazy-browser WARN: could not check browserLoaded");
  }

  await workerHandle.stop();
  await api.close();

  if (ok) {
    console.log("LOGIC SMOKE OK");
    process.exit(0);
  } else {
    console.error("LOGIC SMOKE FAILED");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
