import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePost } from "./index.js";

describe("preparePost", () => {
  it("inserts text into a compose textbox with explicit action delays", async () => {
    const profileDir = mkdtempSync(join(tmpdir(), "zyquor-browser-profile-"));
    const artifactsDir = mkdtempSync(join(tmpdir(), "zyquor-browser-artifacts-"));
    const text = "Local automation needs an audit trail before it touches a public account.";
    const html = encodeURIComponent(`
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
    `);

    const result = await preparePost({
      profileDir,
      artifactsDir,
      text,
      actionDelayMs: 10,
      browserChannel: null,
      closeAfterPrepare: true,
      headless: true,
      xUrl: `data:text/html,${html}`
    });

    expect(result).toEqual({
      status: "prepared",
      insertedText: text,
      postUrl: null
    });
  }, 30_000);
});
