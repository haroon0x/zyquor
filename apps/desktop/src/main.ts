import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from "electron";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { profilesPath } from "@zyquor/core";
import { launchPostingChrome } from "./chrome.js";

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

  app.on("second-instance", () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  if (!process.env.ZYQUOR_DATA_ROOT) {
    process.env.ZYQUOR_DATA_ROOT = app.getPath("userData");
  }

  const { ensureFirstRun } = await import("@zyquor/storage");
  ensureFirstRun(process.env.ZYQUOR_DATA_ROOT);

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
  });

  await api.listen({ host: "127.0.0.1", port: 0 });
  const address = api.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to get API server port");
  }
  const port = address.port;

  const workerApiUrl = `http://127.0.0.1:${port}`;
  const workerHandle = startWorker({
    apiUrl: workerApiUrl,
    autoSeedDefaultIngest: process.env.ZYQUOR_WORKER_AUTO_SEED_DEFAULT_INGEST !== "0",
    ingestIntervalMs: Number(process.env.ZYQUOR_WORKER_INGEST_INTERVAL_MS ?? 60_000),
    pollMs: Number(process.env.ZYQUOR_WORKER_POLL_MS ?? 5000),
  });

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

  const preloadPath = resolve(__dirname, "preload.js");

  const win = new BrowserWindow({
    width: 1024,
    height: 768,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
      additionalArguments: [`--zyquor-api=${workerApiUrl}`],
    },
  });

  win.once("ready-to-show", () => {
    win.show();
  });

  win.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      win.hide();
    }
  });

  const webIndexPath = resolve(__dirname, "../../web/dist/index.html");
  if (existsSync(webIndexPath)) {
    await win.loadFile(webIndexPath);
  } else {
    await win.loadURL(
      "data:text/html,<h1>Zyquor</h1><p>Web UI not built</p>"
    );
  }

  const tray = new Tray(makeTrayIcon());
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Open",
      click: () => {
        win.show();
        win.focus();
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
          tray.setToolTip(`Zyquor — ${message}`);
          if (result.launched) {
            dialog.showMessageBox(win, {
              type: "info",
              title: "Chrome",
              message: "Posting Chrome launched with CDP",
            });
          } else {
            dialog.showMessageBox(win, {
              type: "warning",
              title: "Chrome",
              message: `Could not launch Chrome: ${result.reason ?? "unknown"}`,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          tray.setToolTip(`Zyquor — Chrome error: ${msg}`);
          dialog.showMessageBox(win, {
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
        await workerHandle.stop();
        await api.close();
        app.quit();
      },
    },
  ]);
  tray.setToolTip("Zyquor");
  tray.setContextMenu(contextMenu);

  tray.on("double-click", () => {
    win.show();
    win.focus();
  });

  app.on("before-quit", async () => {
    isQuitting = true;
    await workerHandle.stop();
    await api.close();
  });
}

app.whenReady().then(main);
