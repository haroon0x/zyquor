import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkXLogin, openPostComposer, preparePost, resolveProfileDir } from "./index.js";

function htmlUrl(html: string) {
  return `data:text/html,${encodeURIComponent(html)}`;
}

const chromiumExecutableExists = existsSync(chromium.executablePath());
const describeBrowser = chromiumExecutableExists ? describe : describe.skip;

describe("resolveProfileDir", () => {
  const originalDataRoot = process.env.ZYQUOR_DATA_ROOT;
  const originalWorkspaceRoot = process.env.ZYQUOR_WORKSPACE_ROOT;

  afterEach(() => {
    if (originalDataRoot !== undefined) {
      process.env.ZYQUOR_DATA_ROOT = originalDataRoot;
    } else {
      delete process.env.ZYQUOR_DATA_ROOT;
    }
    if (originalWorkspaceRoot !== undefined) {
      process.env.ZYQUOR_WORKSPACE_ROOT = originalWorkspaceRoot;
    } else {
      delete process.env.ZYQUOR_WORKSPACE_ROOT;
    }
  });

  it("resolves relative path against ZYQUOR_DATA_ROOT when set", () => {
    process.env.ZYQUOR_DATA_ROOT = "/tmp/test-root";
    const result = resolveProfileDir("profiles/personal-main");
    expect(result).toBe("/tmp/test-root/profiles/personal-main");
  });

  it("passes through absolute paths unchanged", () => {
    process.env.ZYQUOR_DATA_ROOT = "/tmp/test-root";
    const result = resolveProfileDir("/absolute/path/profile");
    expect(result).toBe("/absolute/path/profile");
  });

  it("resolves relative path against cwd when ZYQUOR_DATA_ROOT is unset", () => {
    delete process.env.ZYQUOR_DATA_ROOT;
    delete process.env.ZYQUOR_WORKSPACE_ROOT;
    const result = resolveProfileDir("profiles/personal-main");
    expect(result).toBe(join(process.cwd(), "profiles/personal-main"));
  });
});

describe("CDP session guard", () => {
  it("does not fall back to launching a browser when a configured CDP endpoint is unavailable", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "zyquor-browser-profile-"));

    await expect(
      checkXLogin({
        profileDir,
        cdpUrl: "http://127.0.0.1:9"
      })
    ).rejects.toThrow("Refusing to launch a fallback browser against the persistent X profile");
  });
});

describe("reply composer", () => {
  it("navigates to the target post and opens its reply composer", async () => {
    const replyTo = {
      tweetId: "1898765432109876543",
      authorHandle: "target_user",
      url: "https://x.com/target_user/status/1898765432109876543"
    };
    let currentUrl = "https://x.com/home";
    const click = vi.fn(async () => undefined);
    const first = vi.fn(() => ({ click }));
    const locator = vi.fn(() => ({ first }));
    const goto = vi.fn(async (url: string) => {
      currentUrl = url;
      return null;
    });
    const page = {
      goto,
      locator,
      url: () => currentUrl
    } as unknown as Page;

    await openPostComposer(page, "https://x.com/compose/post", replyTo);

    expect(goto).toHaveBeenCalledWith(replyTo.url, { waitUntil: "commit", timeout: 45_000 });
    expect(locator).toHaveBeenCalledWith('article[data-testid="tweet"] [data-testid="reply"], [data-testid="reply"]');
    expect(click).toHaveBeenCalledWith({ timeout: 15_000 });
  });
});

describeBrowser("preparePost", () => {
  it("inserts text into a compose textbox with explicit action delays", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "zyquor-browser-profile-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "zyquor-browser-artifacts-"));
    const text = "Local automation needs an audit trail before it touches a public account.";
    const html = `
      <!doctype html>
      <html>
        <body>
          <main>
            <label for="compose">Post text</label>
            <textarea id="compose" role="textbox"></textarea>
            <button>Post</button>
          </main>
        </body>
      </html>
    `;

    const result = await preparePost({
      profileDir,
      artifactsDir,
      text,
      actionDelayMs: 10,
      browserChannel: null,
      closeAfterPrepare: true,
      headless: true,
      xUrl: htmlUrl(html)
    });

    expect(result).toEqual({
      status: "prepared",
      insertedText: text,
      postUrl: null
    });
  }, 30_000);

  it("preserves line breaks when inserting formatted post text", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "zyquor-browser-profile-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "zyquor-browser-artifacts-"));
    const text = "why this matters:\n\n- faster drafts\n- cleaner review";
    const html = `
      <!doctype html>
      <html>
        <body>
          <main>
            <label for="compose">Post text</label>
            <textarea id="compose" role="textbox"></textarea>
            <button>Post</button>
          </main>
        </body>
      </html>
    `;

    const result = await preparePost({
      profileDir,
      artifactsDir,
      text,
      actionDelayMs: 10,
      browserChannel: null,
      closeAfterPrepare: true,
      headless: true,
      xUrl: htmlUrl(html)
    });

    expect(result.insertedText).toBe(text);
  }, 30_000);

  it("returns verified tweet permalink when submit is enabled", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "zyquor-browser-profile-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "zyquor-browser-artifacts-"));
    const text = "Ship only what you can verify.";
    const html = `
      <!doctype html>
      <html>
        <body>
          <main>
            <label for="compose">Post text</label>
            <textarea id="compose" role="textbox"></textarea>
            <button id="post">Post</button>
            <div id="result"></div>
          </main>
          <script>
            document.getElementById("post").addEventListener("click", () => {
              document.getElementById("compose").value = "";
              const link = document.createElement("a");
              link.href = "/personal/status/1234567890123456789";
              link.textContent = "View post";
              document.getElementById("result").replaceChildren(link);
            });
          </script>
        </body>
      </html>
    `;

    const result = await preparePost({
      profileDir,
      artifactsDir,
      text,
      actionDelayMs: 10,
      browserChannel: null,
      closeAfterPrepare: true,
      headless: true,
      submit: true,
      xUrl: htmlUrl(html)
    });

    expect(result).toEqual({
      status: "posted",
      insertedText: text,
      postUrl: "https://x.com/personal/status/1234567890123456789"
    });
  }, 30_000);

  it("checks whether the persistent profile is logged into X", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "zyquor-browser-profile-"));
    const loggedIn = await checkXLogin({
      profileDir,
      browserChannel: null,
      headless: true,
      xHomeUrl: htmlUrl("<main>Home</main>")
    });
    const loggedOut = await checkXLogin({
      profileDir,
      browserChannel: null,
      headless: true,
      xHomeUrl: htmlUrl('<form><input name="password" /></form>')
    });

    expect(loggedIn.loggedIn).toBe(true);
    expect(loggedOut.loggedIn).toBe(false);
  }, 30_000);
});
