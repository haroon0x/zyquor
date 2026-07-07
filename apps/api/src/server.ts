import { loadDotEnv } from "@zyquor/core";
import { buildApp } from "./app.js";

loadDotEnv();

const port = Number(process.env.ZYQUOR_API_PORT ?? 3000);
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
const app = buildApp({
  enableBrowserPrepare,
  enableBrowserPost,
  ...(browserActionDelayMs ? { browserActionDelayMs } : {}),
  ...(browserTypingDelayMs ? { browserTypingDelayMs } : {}),
  ...(browserChannel ? { browserChannel: browserChannel === "chromium" ? null : browserChannel } : {}),
  ...(browserCdpUrl ? { browserCdpUrl } : {}),
  closeAfterPrepare,
  closeAfterPost
});

try {
  await app.listen({ host: "127.0.0.1", port });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || process.env.ZYQUOR_API_PORT) {
    throw error;
  }

  const fallbackPort = 3001;
  app.log.warn(`Port ${port} is busy; retrying on ${fallbackPort}`);
  await app.listen({ host: "127.0.0.1", port: fallbackPort });
}
