import type { SourceAdapter, SourceItem } from "./types.js";

const NEWS_URL = "https://x.ai/news";

export interface XaiNewsAdapterOptions {
  maxItems?: number;
}

export function createXaiNewsAdapter(options: XaiNewsAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 8;

  return {
    name: "xai-news",
    sourceType: "xai-news",
    async fetch(): Promise<SourceItem[]> {
      try {
        const res = await globalThis.fetch(NEWS_URL, { headers: { "User-Agent": "Zyquor/1.0" } });
        if (!res.ok) return [];
        return parseListing(await res.text()).slice(0, maxItems);
      } catch {
        return [];
      }
    },
    async enrich(item: SourceItem): Promise<SourceItem> {
      try {
        const res = await globalThis.fetch(item.url, { headers: { "User-Agent": "Zyquor/1.0" } });
        if (!res.ok) return item;
        const html = await res.text();
        const body = extractArticleText(html);
        return body ? { ...item, content: body } : item;
      } catch {
        return item;
      }
    }
  };
}

function parseListing(html: string): SourceItem[] {
  const cards = [...html.matchAll(/<a[^>]*href="(\/news\/[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  const seen = new Set<string>();
  const items: SourceItem[] = [];
  for (const match of cards) {
    const slug = match[1] ?? "";
    const body = match[2] ?? "";
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const title = cleanText(firstMatch(body, /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/) ?? "");
    const published = parseDate(firstMatch(body, /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}/) ?? "");
    const blurb = cleanText(firstMatch(body, /<p[^>]*>([\s\S]*?)<\/p>/) ?? "");
    if (!title || !published) continue;
    items.push({
      title,
      url: `https://x.ai${slug}`,
      content: blurb || title,
      metadata: { published, source: "xai-news" }
    });
  }
  return items;
}

function extractArticleText(html: string): string {
  const anchor = html.indexOf("post-title-navigator-anchor");
  if (anchor < 0) return "";
  const start = html.indexOf(">", anchor);
  if (start < 0) return "";
  const mainEnd = html.indexOf("</main>", start);
  const region = mainEnd >= 0 ? html.slice(start, mainEnd) : html.slice(start);
  const lines = cleanLines(region);
  return lines.join(" ").slice(0, 3000);
}

function cleanLines(html: string): string[] {
  return stripTags(html)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 60);
}

function firstMatch(value: string, pattern: RegExp): string | null {
  const match = value.match(pattern);
  return match && match[1] ? match[1] : null;
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, "\n");
}

function cleanText(value: string): string {
  return decodeXml(value.replace(/\s+/g, " ").trim());
}

function parseDate(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}