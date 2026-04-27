import { resolve } from "node:path";
import { checkXLogin } from "../packages/browser/dist/index.js";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const profileDir = resolve(process.env.ZYQUOR_X_PROFILE_DIR ?? "profiles/personal-main");
const browserChannel = process.env.ZYQUOR_BROWSER_CHANNEL;
const cdpUrl = process.env.ZYQUOR_BROWSER_CDP_URL;

let result;
try {
  result = await checkXLogin({
    profileDir,
    ...(browserChannel ? { browserChannel: browserChannel === "chromium" ? null : browserChannel } : {}),
    ...(cdpUrl ? { cdpUrl } : {})
  });
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown X login check error";
  console.error(
    JSON.stringify(
      {
        ok: false,
        profileDir,
        error: message,
        hint: cdpUrl ? "Start `pnpm profile:x:cdp` and keep Chrome open, then rerun this check." : null
      },
      null,
      2
    )
  );
  process.exit(1);
}

console.log(JSON.stringify({ ok: result.loggedIn, profileDir, ...result }, null, 2));

if (!result.loggedIn) {
  process.exit(1);
}

process.exit(0);
