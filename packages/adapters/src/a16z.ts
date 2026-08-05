import type { SourceAdapter, SourceItem } from "./types.js";

const SITEMAP_INDEX_URL = "https://a16z.com/sitemap_index.xml";
const MAX_ARTICLE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface A16zAdapterOptions {
  maxItems?: number;
  now?: Date;
}

export function createA16zAdapter(options: A16zAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 5;

  return {
    name: "a16z",
    sourceType: "a16z",
    async fetch(): Promise<SourceItem[]> {
      const now = options.now ?? new Date();
      try {
        const indexRes = await globalThis.fetch(SITEMAP_INDEX_URL, { headers: { "User-Agent": "Zyquor/1.0" } });
        if (!indexRes.ok) return [];
        const indexBody = await indexRes.text();
        const sitemapUrls = parseSitemapIndex(indexBody)
          .map((url) => new URL(url))
          .filter((url) => url.hostname === "a16z.com" && /^\/post-sitemap/.test(url.pathname))
          .map((url) => url.toString());
        const entriesBySitemap = await Promise.allSettled(sitemapUrls.map(fetchSitemapEntries));
        const entries = entriesBySitemap
          .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
          .sort((a, b) => Date.parse(b.lastmod) - Date.parse(a.lastmod));
        const recent = entries
          .filter((entry) => now.getTime() - Date.parse(entry.lastmod) <= MAX_ARTICLE_AGE_MS)
          .slice(0, maxItems * 2);
        const settled = await Promise.allSettled(recent.map((entry) => fetchArticle(entry, now)));
        return settled
          .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
          .filter((item): item is SourceItem => Boolean(item))
          .slice(0, maxItems);
      } catch {
        return [];
      }
    }
  };
}

interface SitemapEntry {
  url: string;
  lastmod: string;
}

function parseSitemapIndex(html: string): string[] {
  const parts = html.split(/<sitemap[^>]*>/).slice(1);
  return parts
    .map((part) => {
      const loc = part.match(/<loc>([^<]+)<\/loc>/);
      return loc && loc[1] ? loc[1] : null;
    })
    .filter((value): value is string => Boolean(value));
}

async function fetchSitemapEntries(url: string): Promise<SitemapEntry[]> {
  try {
    const res = await globalThis.fetch(url, { headers: { "User-Agent": "Zyquor/1.0" } });
    if (!res.ok) return [];
    const html = await res.text();
    const parts = html.split(/<url[^>]*>/).slice(1);
    const entries: SitemapEntry[] = [];
    for (const part of parts) {
      const loc = part.match(/<loc>([^<]+)<\/loc>/);
      const lastmod = part.match(/<lastmod>([^<]+)<\/lastmod>/);
      if (!loc || !lastmod || !lastmod[1]) continue;
      const url = loc[1] ?? "";
      if (!url.startsWith("https://a16z.com/")) continue;
      entries.push({ url, lastmod: lastmod[1] });
    }
    return entries;
  } catch {
    return [];
  }
}

async function fetchArticle(entry: SitemapEntry, now: Date): Promise<SourceItem | null> {
  const res = await globalThis.fetch(entry.url, { headers: { "User-Agent": "Zyquor/1.0" } });
  if (!res.ok) return null;
  const html = await res.text();
  const published = extractPublished(html) ?? entry.lastmod;
  const title = extractTitle(html);
  if (!title) return null;
  const lines = cleanLines(html);
  const content = [...new Set(lines)].join(" ").slice(0, 2000);
  if (!content && now.getTime() - Date.parse(published) > 48 * 60 * 60 * 1000) return null;
  return {
    title,
    url: entry.url,
    content: content || title,
    ...(typeof published === "string" && published ? { metadata: { published, source: "a16z" } } : {})
  };
}

function extractPublished(html: string): string | null {
  const jsonLd = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  if (jsonLd && jsonLd[1]) return jsonLd[1];
  const meta = html.match(/<meta[^>]*property="article:published_time"[^>]*content="([^"]+)"[^>]*\/?>/);
  return meta && meta[1] ? meta[1] : null;
}

function extractTitle(html: string): string {
  const og = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"[^>]*\/?>/);
  if (og && og[1]) return decodeHtml(og[1]).trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/);
  if (title && title[1]) {
    return decodeHtml(title[1]).replace(/\s*\|\s*(Andreessen Horowitz|a16z)\s*$/i, "").trim();
  }
  return "";
}

function cleanLines(html: string): string[] {
  return stripTags(html)
    .split("\n")
    .map((line) => decodeHtml(line).replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 40);
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, "\n");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;|&ndash;/g, "-")
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)));
}