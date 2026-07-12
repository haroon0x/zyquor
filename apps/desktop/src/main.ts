import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from "electron";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { profilesPath } from "@zyquor/core";
import { launchPostingChrome } from "./chrome.js";
import { initFileLog, logLine } from "./log.js";
import { applyDesktopEnvDefaults, applySettingsToEnv, loadSettings, saveSettings, type DesktopSettings } from "./settings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function makeTrayIcon(): Electron.NativeImage {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = 0xF6;
    pixels[i * 4 + 1] = 0x82;
    pixels[i * 4 + 2] = 0x3B;
    pixels[i * 4 + 3] = 0xFF;
  }
  return nativeImage.createFromBuffer(pixels, { width: size, height: size });
}

app.setName("Zyquor");

let isQuitting = false;

function getCdpPort(): number {
  const cdpUrl = process.env.ZYQUOR_BROWSER_CDP_URL;
  if (cdpUrl) {
    const match = /:(\d+)$/.exec(cdpUrl);
    if (match) return Number(match[1]);
  }
  return Number(process.env.ZYQUOR_BROWSER_CDP_PORT ?? 9222);
}

async function createLaunchPostingChrome() {
  const { createLocalRepository } = await import("@zyquor/storage");
  const repository = await createLocalRepository();

  return async (input: { accountId: string }): Promise<{ launched: boolean; reason?: string }> => {
    const accounts = await repository.listAccounts();
    const account = accounts.find((a) => a.id === input.accountId) ?? accounts[0];
    if (!account) {
      return { launched: false, reason: "account-not-found" };
    }
    const profileDir = profilesPath(account.profileDir.replace(/^profiles\//, ""));
    const port = getCdpPort();
    return launchPostingChrome({ profileDir, cdpPort: port });
  };
}

async function main() {
  const headlessSmoke = process.argv.includes("--headless-smoke");

  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  if (!process.env.ZYQUOR_DATA_ROOT) {
    process.env.ZYQUOR_DATA_ROOT = app.getPath("userData");
  }

  initFileLog(process.env.ZYQUOR_DATA_ROOT);
  logLine("info", "app boot");

  // Load desktop settings and apply to env before packages read process.env.
  // Keys are stored plain in userData; OS keychain integration is future work.
  const desktopSettings = loadSettings(process.env.ZYQUOR_DATA_ROOT);
  applySettingsToEnv(desktopSettings);
  applyDesktopEnvDefaults(desktopSettings);

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

  const enableBrowserPrepare = process.env.ZYQUOR_ENABLE_BROWSER_PREPARE === "1";
  const enableBrowserPost = process.env.ZYQUOR_ENABLE_BROWSER_POST === "1";
  const browserChannel = process.env.ZYQUOR_BROWSER_CHANNEL;
  const browserCdpUrl = process.env.ZYQUOR_BROWSER_CDP_URL;
  const browserActionDelayMs = process.env.ZYQUOR_BROWSER_ACTION_DELAY_MS
    ? Number(process.env.ZYQUOR_BROWSER_ACTION_DELAY_MS)
    : undefined;
  const browserTypingDelayMs = process.env.ZYQUOR_BROWSER_TYPING_DELAY_MS
    ? Number(process.env.ZYQUOR_BROWSER_TYPING_DELAY_MS)
    : undefined;
  const closeAfterPrepare = process.env.ZYQUOR_BROWSER_CLOSE_AFTER_PREPARE !== "0";
  const closeAfterPost = process.env.ZYQUOR_BROWSER_CLOSE_AFTER_POST !== "0";

  const desktopLaunchPostingChrome = await createLaunchPostingChrome();

  const dataRoot = process.env.ZYQUOR_DATA_ROOT;
  let currentSettings = desktopSettings;
  const desktopSettingsDep = {
    get(): DesktopSettings {
      return currentSettings;
    },
    update(patch: DesktopSettings): DesktopSettings {
      currentSettings = { ...currentSettings, ...patch };
      for (const key of Object.keys(patch) as (keyof DesktopSettings)[]) {
        const value = patch[key];
        if (value === "") {
          delete currentSettings[key];
        }
      }
      saveSettings(dataRoot, currentSettings);
      applySettingsToEnv(currentSettings);

      // Wire startWithWindows
      if (!headlessSmoke && process.platform === "win32") {
        app.setLoginItemSettings({
          openAtLogin: !!currentSettings.startWithWindows,
          args: ["--hidden"],
        });
      }

      return currentSettings;
    },
  };

  const api = buildApp({
    enableBrowserPrepare,
    enableBrowserPost,
    ...(browserActionDelayMs != null ? { browserActionDelayMs } : {}),
    ...(browserTypingDelayMs != null ? { browserTypingDelayMs } : {}),
    ...(browserChannel ? { browserChannel: browserChannel === "chromium" ? null : browserChannel } : {}),
    ...(browserCdpUrl ? { browserCdpUrl } : {}),
    closeAfterPrepare,
    closeAfterPost,
    launchPostingChrome: desktopLaunchPostingChrome,
    desktopSettings: desktopSettingsDep,
  });

  await api.listen({ host: "127.0.0.1", port: 0 });
  const address = api.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get API server port");
  }
  const port = address.port;
  logLine("info", `api listening on port ${port}`);

  const workerApiUrl = `http://127.0.0.1:${port}`;
  const workerHandle = startWorker({
    apiUrl: workerApiUrl,
    autoSeedDefaultIngest: process.env.ZYQUOR_WORKER_AUTO_SEED_DEFAULT_INGEST !== "0",
    ingestIntervalMs: Number(process.env.ZYQUOR_WORKER_INGEST_INTERVAL_MS ?? 60_000),
    pollMs: Number(process.env.ZYQUOR_WORKER_POLL_MS ?? 5000),
  });
  logLine("info", "worker started");

  if (headlessSmoke) {
    await new Promise((resolve) => setTimeout(resolve, 500));

    let ok = true;
    for (const path of ["/accounts", "/worker/status"]) {
      try {
        const res = await fetch(`${workerApiUrl}${path}`);
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

    await workerHandle.stop();
    await api.close();

    if (ok) {
      console.log("HEADLESS SMOKE OK");
      process.exit(0);
    } else {
      console.error("HEADLESS SMOKE FAILED");
      process.exit(1);
    }
  }

  // Wire startWithWindows at startup
  if (!headlessSmoke && process.platform === "win32") {
    app.setLoginItemSettings({
      openAtLogin: !!desktopSettings.startWithWindows,
      args: ["--hidden"],
    });
  }

  const preloadPath = resolve(__dirname, "preload.js");
  const webIndexPath = resolve(__dirname, "../../web/dist/index.html");

  let win: BrowserWindow | null = null;

  function showOrCreateWindow() {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: 1024,
      height: 768,
      title: "Zyquor",
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: preloadPath,
        additionalArguments: [`--zyquor-api=${workerApiUrl}`, `--zyquor-version=${app.getVersion()}`],
      },
    });

    win.once("ready-to-show", () => {
      win!.show();
    });

    win.on("closed", () => {
      win = null;
    });

    if (existsSync(webIndexPath)) {
      void win.loadFile(webIndexPath);
    } else {
      void win.loadURL(
        "data:text/html,<h1>Zyquor</h1><p>Web UI not built</p>"
      );
    }
  }

  app.on("second-instance", () => {
    showOrCreateWindow();
  });

  // --hidden: don't show window at startup (tray only)
  if (!process.argv.includes("--hidden")) {
    showOrCreateWindow();
  }

  const tray = new Tray(makeTrayIcon());
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open",
      click: () => {
        showOrCreateWindow();
      },
    },
    { type: "separator" },
    {
      label: "Launch posting Chrome",
      click: async () => {
        if (headlessSmoke) return;
        try {
          const result = await desktopLaunchPostingChrome({ accountId: "account_personal" });
          const message = result.launched
            ? "Chrome launched"
            : `Chrome not launched: ${result.reason ?? "unknown"}`;
          logLine(result.launched ? "info" : "warn", `chrome launch: ${message}`);
          tray.setToolTip(`Zyquor — ${message}`);
          if (result.launched) {
            dialog.showMessageBox(win!, {
              type: "info",
              title: "Chrome",
              message: "Posting Chrome launched with CDP",
            });
          } else {
            dialog.showMessageBox(win!, {
              type: "warning",
              title: "Chrome",
              message: `Could not launch Chrome: ${result.reason ?? "unknown"}`,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          logLine("error", `chrome launch error: ${msg}`);
          tray.setToolTip(`Zyquor — Chrome error: ${msg}`);
          dialog.showMessageBox(win!, {
            type: "error",
            title: "Chrome",
            message: `Chrome launch error: ${msg}`,
          });
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: async () => {
        isQuitting = true;
        clearInterval(failurePoll);
        await workerHandle.stop();
        await api.close();
        app.quit();
      },
    },
  ]);
  tray.setToolTip("Zyquor");
  tray.setContextMenu(contextMenu);

  // Poll job failures for tray tooltip
  let failurePoll = setInterval(async () => {
    try {
      const res = await fetch(`${workerApiUrl}/jobs`);
      if (!res.ok) return;
      const body = (await res.json()) as { jobs?: Array<{ status: string }> };
      const failedCount = (body.jobs ?? []).filter((j) => j.status === "failed").length;
      if (failedCount > 0) {
        tray.setToolTip(`Zyquor — ${failedCount} failed job(s)`);
      } else {
        tray.setToolTip("Zyquor");
      }
    } catch {
      // silently ignore poll errors
    }
  }, 60_000);

  tray.on("double-click", () => {
    showOrCreateWindow();
  });

  // App stays in tray when window is closed — do not quit.
  app.on("window-all-closed", () => {});

  app.on("before-quit", async () => {
    isQuitting = true;
    clearInterval(failurePoll);
    logLine("info", "app quitting");
    await workerHandle.stop();
    await api.close();
  });
}

app.whenReady().then(main);
