import type { SourceAdapter, SourceItem } from "./types.js";

const CHANGELOG_URL = "https://cursor.com/changelog";

export interface CursorChangelogAdapterOptions {
  maxItems?: number;
}

export function createCursorChangelogAdapter(options: CursorChangelogAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 8;

  return {
    name: "cursor-changelog",
    sourceType: "cursor-changelog",
    async fetch(): Promise<SourceItem[]> {
      try {
        const res = await globalThis.fetch(CHANGELOG_URL, { headers: { "User-Agent": "Zyquor/1.0" } });
        if (!res.ok) return [];
        return parseEntries(await res.text()).slice(0, maxItems);
      } catch {
        return [];
      }
    }
  };
}

function parseEntries(html: string): SourceItem[] {
  const parts = html.split(/<article[^>]*>/).slice(1);
  const items: SourceItem[] = [];
  for (const part of parts) {
    const published = firstMatch(part, /<time[^>]*dateTime="([^"]+)"[^>]*>/);
    const title = cleanText(stripTags(firstMatch(part, /<h1[^>]*>([\s\S]*?)<\/h1>/) ?? ""));
    const slug = firstMatch(part, /href="\/changelog\/([a-z0-9-]+)"/);
    if (!published || !title || !slug) continue;
    const body = cleanText(stripTags(part));
    const titleIndex = body.indexOf(title);
    const content = (titleIndex >= 0 ? body.slice(titleIndex) : body) || title;
    items.push({
      title,
      url: `https://cursor.com/changelog/${slug}`,
      content,
      metadata: { published: new Date(published).toISOString(), source: "cursor-changelog" }
    });
  }
  return items;
}

function firstMatch(value: string, pattern: RegExp): string | null {
  const match = value.match(pattern);
  return match && match[1] ? match[1].trim() : null;
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");
}

function cleanText(value: string): string {
  return decodeXml(value.replace(/\s+/g, " ").trim());
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
