import type { SourceAdapter, SourceItem } from "./types.js";

export interface RssAdapterOptions {
  maxItems?: number;
}

export function createRssAdapter(options: RssAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 10;

  return {
    name: "rss",
    sourceType: "feed",
    async fetch(configMetadata?: Record<string, unknown>): Promise<SourceItem[]> {
      const feedUrl = configMetadata?.feedUrl as string | undefined;
      if (!feedUrl) return [];

      try {
        const res = await globalThis.fetch(feedUrl);
        if (!res.ok) return [];

        const xml = await res.text();
        const items = parseRssItems(xml);
        return items.slice(0, maxItems);
      } catch {
        return [];
      }
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

    const title = decodeXml(extractXmlTag(itemXml, "title"));
    const link = decodeXml(extractXmlTag(itemXml, "link") || extractXmlTag(itemXml, "guid"));
    const description = decodeXml(extractXmlTag(itemXml, "description") || extractXmlTag(itemXml, "content:encoded"));
    const published = decodeXml(extractXmlTag(itemXml, "pubDate") || extractXmlTag(itemXml, "dc:date"));
    const imageUrl = extractRssImageUrl(itemXml);

    if (title && link) {
      items.push({
        title,
        url: link,
        content: description || title,
        ...(imageUrl ? { imageUrl } : {}),
        ...(published ? { metadata: { published } } : {})
      });
    }
  }

  return items;
}

function extractXmlTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const match = xml.match(regex);
  return match && match[1] ? stripCdata(match[1]).trim() : "";
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
  return xml.match(regex)?.[1]?.trim() ?? "";
}

function stripCdata(value: string): string {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}
