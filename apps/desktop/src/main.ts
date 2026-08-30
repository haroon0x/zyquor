import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Tray } from "electron";
import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { profilesPath } from "@zyquor/core";
import { closePostingChrome, isCdpUp, launchedPostingChromePid, launchPostingChrome } from "./chrome.js";
import { initFileLog, logLine, logTail } from "./log.js";
import { applyDesktopEnvDefaults, applySettingsToEnv, loadSettings, saveSettings, type DesktopSettings } from "./settings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type UpdateStatus = {
  state: "checking" | "available" | "downloaded" | "error";
  version: string | null;
};

let updateStatus: UpdateStatus | null = null;

function setUpdateStatus(status: UpdateStatus | null): void {
  updateStatus = status;
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("zyquor:update-status", status);
  }
}

ipcMain.handle("zyquor:update-status:get", () => updateStatus);

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

function loadAppIcon(): Electron.NativeImage | null {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : resolve(__dirname, "../build/icon.png");
  if (!existsSync(iconPath)) return null;
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? null : icon;
}

function captureConsole(): void {
  const forward = (level: string) => (...args: unknown[]) => {
    const text = args
      .map((arg) => (arg instanceof Error ? arg.stack ?? arg.message : typeof arg === "string" ? arg : JSON.stringify(arg)))
      .join(" ");
    if (text.length > 0) logLine(level, text);
  };
  console.log = forward("info");
  console.info = forward("info");
  console.warn = forward("warn");
  console.error = forward("error");
}

const ROUTINE_POLL_PATHS = /^\/(health|worker\/(status|heartbeat)|system\/(status|logs)|(jobs|ingest-runs)\/recover-stale)\b/;

function makeApiLogStream() {
  const urlByRequestId = new Map<string, string>();

  return {
    write(chunk: string) {
      for (const raw of chunk.split("\n")) {
        if (!raw.trim()) continue;
        let entry: {
          level?: number;
          msg?: string;
          reqId?: string;
          req?: { method?: string; url?: string };
          res?: { statusCode?: number };
          responseTime?: number;
        };
        try {
          entry = JSON.parse(raw);
        } catch {
          logLine("info", `api ${raw.slice(0, 500)}`);
          continue;
        }

        const level = (entry.level ?? 30) >= 50 ? "error" : (entry.level ?? 30) >= 40 ? "warn" : "info";
        const method = entry.req?.method ?? "GET";
        const url = entry.req?.url;

        if (url) {
          if (entry.reqId) {
            urlByRequestId.set(entry.reqId, `${method} ${url}`);
            if (urlByRequestId.size > 200) urlByRequestId.delete(urlByRequestId.keys().next().value!);
          }
          if (method === "GET" || ROUTINE_POLL_PATHS.test(url)) continue;
          logLine(level, `api ${method} ${url}`);
          continue;
        }

        if (entry.res?.statusCode !== undefined) {
          const label = entry.reqId ? urlByRequestId.get(entry.reqId) : undefined;
          if (entry.reqId) urlByRequestId.delete(entry.reqId);
          if (entry.res.statusCode < 400) continue;
          logLine("warn", `api ${entry.res.statusCode} ${label ?? ""} in ${Math.round(entry.responseTime ?? 0)}ms`.replace(/\s+/g, " "));
          continue;
        }

        if (entry.msg) logLine(level, `api ${entry.msg}`);
      }
    },
  };
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

function cdpPortForProfile(profileDir: string): number {
  const base = getCdpPort();
  const normalized = profileDir.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("personal-main")) return base;
  if (normalized.includes("willainotice")) return base + 1;
  let h = 0;
  for (let i = 0; i < normalized.length; i++) h = (h * 31 + normalized.charCodeAt(i)) % 10;
  return base + h;
}

function dataRoot(): string {
  return process.env.ZYQUOR_DATA_ROOT ?? "";
}

// Single-account rule: the posting Chrome carries one X login. The shared
// state file records which account profile it carries; hardcoded callers
// (tray, startup) defer to the recorded active account when one exists.
async function activePostingAccountId(): Promise<string> {
  try {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { createSqliteRepository } = await import("@zyquor/storage");
    const repository = await createSqliteRepository();
    const accounts = await repository.listAccounts();
    const parsed = JSON.parse(readFileSync(resolve(dataRoot(), "posting-chrome.json"), "utf8")) as {
      profileDir?: string;
    };
    if (typeof parsed.profileDir === "string") {
      const active = accounts.find((a) => resolve(dataRoot(), a.profileDir) === resolve(parsed.profileDir!));
      if (active) return active.id;
    }
  } catch {
    /* fall through to default */
  }
  return "account_personal";
}

async function createLaunchPostingChrome() {
  const { createSqliteRepository } = await import("@zyquor/storage");
  const repository = await createSqliteRepository();

  return async (input: { accountId: string }): Promise<{ launched: boolean; reason?: string }> => {
    const accounts = await repository.listAccounts();
    const account = accounts.find((a) => a.id === input.accountId) ?? accounts[0];
    if (!account) {
      return { launched: false, reason: "account-not-found" };
    }
    const profileDir = profilesPath(account.profileDir.replace(/^profiles\//, ""));
    const port = cdpPortForProfile(account.profileDir);
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
  captureConsole();
  logLine("info", "app boot");

  // Load desktop settings and apply to env before packages read process.env.
  const desktopSettings: DesktopSettings = {
    enableBrowserPrepare: true,
    enableBrowserPost: true,
    closeChromeAfterPost: true,
    cdpPort: 9222,
    startWithWindows: false,
    autoApproveSourcePackets: true,
    llmProvider: "opencode",
    ...loadSettings(process.env.ZYQUOR_DATA_ROOT),
  };
  applySettingsToEnv(desktopSettings);
  applyDesktopEnvDefaults(desktopSettings);
  if (headlessSmoke) {
    process.env.ZYQUOR_ENABLE_BROWSER_PREPARE = "0";
    process.env.ZYQUOR_ENABLE_BROWSER_POST = "0";
  }

  const { ensureFirstRun, detectSqliteSupport } = await import("@zyquor/storage");
  ensureFirstRun(process.env.ZYQUOR_DATA_ROOT);

  const sqliteCheck = await detectSqliteSupport();
  if (!sqliteCheck.available) {
    throw new Error(`node:sqlite is required for storage (Node >= 22.5). ${sqliteCheck.error ?? ""}`);
  }
  console.log("storage: node:sqlite available");

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
  app.setPath("crashDumps", join(dataRoot, "crashes"));
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
      applySettingsToEnv(currentSettings, { overwrite: true });

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

  const startedAt = new Date().toISOString();
  let workerControl: { isPaused(): boolean; setPaused(paused: boolean): void } | null = null;
  let quitEverything: () => Promise<void> = async () => undefined;

  const desktopControl = {
    async closeChrome() {
      const { createSqliteRepository } = await import("@zyquor/storage");
      const repository = await createSqliteRepository();
      const accounts = await repository.listAccounts();
      let closedAny = false;
      for (const acc of accounts.filter((a) => a.enabled)) {
        const port = cdpPortForProfile(acc.profileDir);
        const result = await closePostingChrome({ cdpPort: port }).catch(() => ({ closed: false }));
        if (result.closed) closedAny = true;
      }
      const result = { closed: closedAny, reason: closedAny ? undefined : "not-running" };
      logLine(result.closed ? "info" : "warn", `chrome close: ${result.closed ? "closed" : result.reason ?? "unknown"}`);
      return result;
    },
    async logTail(lines: number) {
      return logTail(lines);
    },
    async quit() {
      logLine("info", "quit requested from UI");
      await quitEverything();
      app.quit();
    },
    async restart() {
      logLine("info", "restart requested from UI");
      await quitEverything();
      app.relaunch();
      app.exit(0);
    },
    async setWorkerPaused(paused: boolean) {
      workerControl?.setPaused(paused);
      logLine("info", `worker ${paused ? "paused" : "resumed"} from UI`);
      return workerControl?.isPaused() ?? false;
    },
    async status() {
      const cdpUrl = `http://127.0.0.1:${getCdpPort()}`;
      const { createSqliteRepository } = await import("@zyquor/storage");
      const repository = await createSqliteRepository().catch(() => null);
      const accounts = repository ? await repository.listAccounts().catch(() => []) : [];
      const chromes = [];
      for (const acc of accounts.filter((a) => a.enabled)) {
        const port = cdpPortForProfile(acc.profileDir);
        const url = `http://127.0.0.1:${port}`;
        chromes.push({ accountId: acc.id, handle: acc.handle, cdpUrl: url, port, connected: await isCdpUp(url) });
      }
      return {
        appVersion: app.getVersion(),
        cdpUrl,
        chromeConnected: await isCdpUp(cdpUrl),
        chromePid: launchedPostingChromePid(),
        chromes,
        dataRoot,
        logPath: join(dataRoot, "logs", "main.log"),
        platform: process.platform,
        startedAt,
        workerPaused: workerControl?.isPaused() ?? false
      };
    }
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
    desktopControl,
    logStream: makeApiLogStream(),
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
  workerControl = workerHandle;
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

  const preloadPath = resolve(__dirname, "preload.cjs");
  const bundledWebIndexPath = resolve(__dirname, "web/index.html");
  const devWebIndexPath = resolve(__dirname, "../../web/dist/index.html");
  const webIndexPath = existsSync(bundledWebIndexPath)
    ? bundledWebIndexPath
    : devWebIndexPath;
  const appIcon = loadAppIcon();

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
      ...(appIcon ? { icon: appIcon } : {}),
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

    win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      logLine("error", `web UI failed to load (${errorCode}): ${errorDescription}`);
      if (!win || win.isDestroyed()) return;
      void win.loadURL("data:text/html,<h1>Zyquor</h1><p>The desktop UI failed to load. Check the log file and restart Zyquor.</p>");
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

  const trayIcon = appIcon?.resize({ width: 16, height: 16 }) ?? makeTrayIcon();
  const tray = new Tray(trayIcon);
  let failurePoll: ReturnType<typeof setInterval> | null = null;
  let updatePoll: ReturnType<typeof setInterval> | null = null;
  let updater: AppUpdater | null = null;
  let updateReadyVersion: string | null = null;

  function clearPolls(): void {
    if (failurePoll) {
      clearInterval(failurePoll);
      failurePoll = null;
    }
    if (updatePoll) {
      clearInterval(updatePoll);
      updatePoll = null;
    }
  }

  let shutdown: Promise<void> | null = null;
  quitEverything = async () => {
    if (!shutdown) {
      shutdown = (async () => {
        isQuitting = true;
        clearPolls();
        workerHandle.setPaused(true);
        await workerHandle.stop();
        await api.close();
        try {
          const { createSqliteRepository } = await import("@zyquor/storage");
          const repository = await createSqliteRepository();
          const accounts = await repository.listAccounts();
          for (const acc of accounts.filter((a) => a.enabled)) {
            await closePostingChrome({ cdpPort: cdpPortForProfile(acc.profileDir) }).catch(() => undefined);
          }
        } catch {
          await closePostingChrome({ cdpPort: getCdpPort() }).catch(() => undefined);
        }
        logLine("info", "shutdown complete");
      })();
    }
    await shutdown;
  };

  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open",
      click: () => {
        showOrCreateWindow();
      },
    },
    {
      id: "restart-to-update",
      label: "Restart to update",
      visible: false,
      click: async () => {
        const selectedUpdater = updater;
        if (!selectedUpdater) return;
        isQuitting = true;
        clearPolls();
        await workerHandle.stop();
        await api.close();
        selectedUpdater.quitAndInstall(false, true);
      },
    },
    { type: "separator" },
    {
      label: "Launch posting Chrome",
      click: async () => {
        if (headlessSmoke) return;
        const dialogParent = win && !win.isDestroyed() ? win : undefined;
        try {
          const { createSqliteRepository } = await import("@zyquor/storage");
          const repository = await createSqliteRepository();
          const accounts = await repository.listAccounts();
          const enabled = accounts.filter((a) => a.enabled);
          const results = await Promise.all(enabled.map((acc) => desktopLaunchPostingChrome({ accountId: acc.id })));
          const result = { launched: results.some((r) => r.launched), reason: results.find((r) => !r.launched)?.reason ?? "already-running" };
          const message = result.launched
            ? "Chrome launched"
            : `Chrome not launched: ${result.reason ?? "unknown"}`;
          logLine(result.launched ? "info" : "warn", `chrome launch: ${message}`);
          tray.setToolTip(`Zyquor — ${message}`);
          if (result.launched) {
            dialog.showMessageBox(dialogParent!, {
              type: "info",
              title: "Chrome",
              message: "Posting Chrome launched with CDP",
            });
          } else {
            dialog.showMessageBox(dialogParent!, {
              type: "warning",
              title: "Chrome",
              message: `Could not launch Chrome: ${result.reason ?? "unknown"}`,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          logLine("error", `chrome launch error: ${msg}`);
          tray.setToolTip(`Zyquor — Chrome error: ${msg}`);
          dialog.showMessageBox(dialogParent!, {
            type: "error",
            title: "Chrome",
            message: `Chrome launch error: ${msg}`,
          });
        }
      },
    },
    {
      label: "Stop everything",
      click: async () => {
        try {
          await fetch(`${workerApiUrl}/system/stop-all`, { method: "POST" });
          logLine("warn", "stop everything from tray");
          tray.setToolTip("Zyquor — stopped");
        } catch (error) {
          logLine("error", `stop everything failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: async () => {
        await quitEverything();
        app.quit();
      },
    },
  ]);
  tray.setToolTip("Zyquor");
  tray.setContextMenu(contextMenu);

  void (async () => {
    const { createSqliteRepository } = await import("@zyquor/storage");
    const repository = await createSqliteRepository();
    const accounts = await repository.listAccounts();
    const enabled = accounts.filter((a) => a.enabled);
    const results = await Promise.all(enabled.map((acc) => desktopLaunchPostingChrome({ accountId: acc.id })));
    const launched = results.filter((r) => r.launched || r.reason === "already-running").length;
    const message = launched > 0 ? `Chrome connected (${launched}/${enabled.length})` : `Chrome unavailable`;
    logLine(launched > 0 ? "info" : "warn", `startup chrome: ${message}`);
    tray.setToolTip(`Zyquor — ${message}`);
  })().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    logLine("error", `startup chrome error: ${message}`);
    tray.setToolTip(`Zyquor — Chrome error`);
  });

  if (app.isPackaged && existsSync(join(process.resourcesPath, "app-update.yml"))) {
    const { autoUpdater } = electronUpdater;
    updater = autoUpdater;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
      logLine("info", "updater checking-for-update");
      setUpdateStatus({ state: "checking", version: null });
    });
    autoUpdater.on("update-available", (info: UpdateInfo) => {
      logLine("info", `updater update-available version ${info.version}`);
      setUpdateStatus({ state: "available", version: info.version });
    });
    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      logLine("info", `updater update-not-available version ${info.version}`);
      setUpdateStatus(null);
    });
    autoUpdater.on("download-progress", (progress: ProgressInfo) => {
      logLine("info", `updater download-progress ${progress.percent.toFixed(1)}%`);
    });
    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      logLine("info", `updater update-downloaded version ${info.version}`);
      updateReadyVersion = info.version;
      setUpdateStatus({ state: "downloaded", version: info.version });
      if (updatePoll) {
        clearInterval(updatePoll);
        updatePoll = null;
      }
      const restartToUpdateItem = contextMenu.getMenuItemById("restart-to-update");
      if (restartToUpdateItem) {
        restartToUpdateItem.visible = true;
        tray.setContextMenu(contextMenu);
      }
    });
    autoUpdater.on("update-cancelled", (info: UpdateInfo) => {
      logLine("warn", `updater update-cancelled version ${info.version}`);
    });
    autoUpdater.on("appimage-filename-updated", (path: string) => {
      logLine("info", `updater appimage-filename-updated ${path}`);
    });
    autoUpdater.on("error", (error: Error) => {
      logLine("error", `updater error: ${error.stack ?? error.message}`);
      setUpdateStatus({ state: "error", version: updateReadyVersion });
    });

    const checkForUpdates = () => {
      void autoUpdater.checkForUpdates().catch(() => undefined);
    };
    checkForUpdates();
    updatePoll = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
  }

  // Poll job failures for tray tooltip
  failurePoll = setInterval(async () => {
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

  app.on("before-quit", (event) => {
    if (shutdown) return;
    event.preventDefault();
    logLine("info", "app quitting");
    void quitEverything().finally(() => app.exit(0));
  });
}

app.on("child-process-gone", (_e, details) =>
  logLine("error", "child-process-gone: " + JSON.stringify(details))
);
app.on("render-process-gone", (_e, _wc, details) =>
  logLine("error", "render-process-gone: " + JSON.stringify(details))
);
process.on("exit", (code) => logLine("info", "process exit code " + code));

app.whenReady().then(main).catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  logLine("error", `startup failed: ${message}`);
  dialog.showErrorBox("Zyquor could not start", message);
  app.quit();
});
