import type { SourceAdapter, SourceItem, CrawlService } from "./types.js";

export interface TechCrunchAdapterOptions {
  crawlService?: CrawlService;
  maxItems?: number;
  sections?: string[];
}

export function createTechCrunchAdapter(options: TechCrunchAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 10;
  const sections = options.sections ?? ["startups", "ai"];
  const crawlService = options.crawlService;

  const rssUrls = sections.map(s => `https://techcrunch.com/category/${s}/feed/`);
  const mainFeed = "https://techcrunch.com/feed/";

  return {
    name: "techcrunch",
    sourceType: "news",
    async fetch(): Promise<SourceItem[]> {
      const allItems: SourceItem[] = [];
      const feedsToFetch = [mainFeed, ...rssUrls];

      for (const feedUrl of feedsToFetch) {
        try {
          const res = await globalThis.fetch(feedUrl, { headers: { "User-Agent": "Zyquor/1.0" } });
          if (!res.ok) continue;

          const xml = await res.text();
          const items = parseRssItems(xml);
          allItems.push(...items);
        } catch {}
      }

      const seen = new Set<string>();
      const unique = allItems.filter(item => {
        if (seen.has(item.title)) return false;
        seen.add(item.title);
        return true;
      });

      return unique.slice(0, maxItems);
    }
  };
}

function parseRssItems(xml: string): SourceItem[] {
  const items: SourceItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    if (!itemXml) continue;

    const title = decodeXml(extractTag(itemXml, "title"));
    const link = decodeXml(extractTag(itemXml, "link"));
    const description = decodeXml(stripCdata(extractTag(itemXml, "description") || extractTag(itemXml, "content:encoded") || ""));
    const pubDate = extractTag(itemXml, "pubDate");
    const category = decodeXml(extractTag(itemXml, "category") || "");
    const imageUrl = extractRssImageUrl(itemXml);

    if (title && link) {
      items.push({ title, url: link, content: description || title, ...(imageUrl ? { imageUrl } : {}), metadata: { pubDate, category } });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const match = xml.match(regex);
  return match?.[1]?.trim() || "";
}

function extractRssImageUrl(xml: string) {
  const mediaUrl =
    extractAttribute(xml, "media:content", "url") ||
    extractAttribute(xml, "media:thumbnail", "url") ||
    extractAttribute(xml, "enclosure", "url");
  return mediaUrl && /\.(avif|gif|jpe?g|png|webp)(\?|$)/i.test(mediaUrl) ? decodeXml(mediaUrl) : "";
}

function extractAttribute(xml: string, tag: string, attribute: string) {
  const regex = new RegExp(`<${tag}[^>]*\\s${attribute}=["']([^"']+)["'][^>]*>`, "i");
  return xml.match(regex)?.[1]?.trim() || "";
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
