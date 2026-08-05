import type { SourceAdapter, SourceItem } from "./types.js";

const UPDATES_URL = "https://api-docs.deepseek.com/updates/";

export interface DeepSeekUpdatesAdapterOptions {
  maxItems?: number;
}

export function createDeepSeekUpdatesAdapter(options: DeepSeekUpdatesAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 5;

  return {
    name: "deepseek-updates",
    sourceType: "deepseek-updates",
    async fetch(): Promise<SourceItem[]> {
      try {
        const res = await globalThis.fetch(UPDATES_URL, { headers: { "User-Agent": "Zyquor/1.0" } });
        if (!res.ok) return [];
        return parseEntries(await res.text()).slice(0, maxItems);
      } catch {
        return [];
      }
    }
  };
}

function parseEntries(html: string): SourceItem[] {
  const parts = html.split(/<h2[^>]*id="date-(\d{4}-\d{2}-\d{2})"[^>]*>/);
  const items: SourceItem[] = [];
  for (let index = 1; index < parts.length; index += 2) {
    const datePart = parts[index] ?? "";
    const body = parts[index + 1] ?? "";
    if (!datePart || !/^\d{4}-\d{2}-\d{2}$/.test(datePart) || !body.trim()) continue;
    const heading = firstMatch(body, /<h3[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/h3>/);
    const title = cleanText(stripTags(heading?.text ?? ""));
    if (!heading?.id || !title) continue;
    items.push({
      title,
      url: `${UPDATES_URL}#${heading.id}`,
      content: cleanText(stripTags(body)) || title,
      metadata: { published: `${datePart}T12:00:00.000Z`, source: "deepseek-updates" }
    });
  }
  return items;
}

function firstMatch(value: string, pattern: RegExp): { id: string; text: string } | null {
  const match = value.match(pattern);
  return match && match[1] && match[2] ? { id: match[1], text: match[2] } : null;
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ");
}

function cleanText(value: string): string {
  return decodeXml(
    value
      .replace(/&nbsp;/g, " ")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}
