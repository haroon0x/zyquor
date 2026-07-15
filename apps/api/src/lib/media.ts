import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { workspaceRoot } from "./paths.js";

function mediaUrlsFromDraftMetadata(metadata: Record<string, unknown>) {
  const urls = Array.isArray(metadata.mediaUrls) ? metadata.mediaUrls : [];
  return urls.filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url)).slice(0, 4);
}

function extensionForMedia(url: string, contentType: string | null) {
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  if ([".avif", ".gif", ".jpg", ".jpeg", ".png", ".webp"].includes(fromUrl)) {
    return fromUrl;
  }
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("gif")) return ".gif";
  if (contentType?.includes("avif")) return ".avif";
  return ".jpg";
}

async function downloadMediaUrls(urls: string[]) {
  if (urls.length === 0) {
    return [];
  }

  const mediaDir = resolve(workspaceRoot(), "data/media");
  mkdirSync(mediaDir, { recursive: true });
  const paths: string[] = [];

  for (const url of urls) {
    const response = await fetch(url, { headers: { "user-agent": "Zyquor/1.0" } });
    if (!response.ok) {
      throw new Error(`Media download failed: ${response.status} ${url}`);
    }
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`Media URL is not an image: ${url}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
      throw new Error(`Media size is invalid: ${url}`);
    }
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
    const path = resolve(mediaDir, `${hash}${extensionForMedia(url, contentType)}`);
    await writeFile(path, bytes);
    paths.push(path);
  }

  return paths;
}

export async function mediaPathsForDraft(draft: { metadata: Record<string, unknown> }) {
  return downloadMediaUrls(mediaUrlsFromDraftMetadata(draft.metadata));
}
