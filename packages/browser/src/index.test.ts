import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { checkXLogin, preparePost } from "./index.js";

function htmlUrl(html: string) {
  return `data:text/html,${encodeURIComponent(html)}`;
}

const chromiumExecutableExists = existsSync(chromium.executablePath());
const describeBrowser = chromiumExecutableExists ? describe : describe.skip;

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
