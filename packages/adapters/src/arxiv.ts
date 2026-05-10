import type { SourceAdapter, SourceItem } from "./types.js";

const ARXIV_API = "https://export.arxiv.org/api/query";
const ARXIV_RSS_BASE = "https://rss.arxiv.org/rss";

export interface ArxivAdapterOptions {
  maxItems?: number;
  searchQuery?: string;
  categories?: string[];
}

export function createArxivAdapter(options: ArxivAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 10;
  const categories = options.categories ?? ["cs.AI", "cs.LG", "cs.CL"];
  const searchQuery = options.searchQuery ?? categories.map(c => `cat:${c}`).join(" OR ");

  return {
    name: "arxiv",
    sourceType: "feed",
    async fetch(): Promise<SourceItem[]> {
      const headers = { "User-Agent": "Zyquor/1.0 (local source monitor)" };
      if (!options.searchQuery) {
        return fetchArxivRssFallback(categories, maxItems, headers).catch(() => []);
      }

      try {
        const url = `${ARXIV_API}?search_query=${encodeURIComponent(searchQuery)}&start=0&max_results=${maxItems}&sortBy=submittedDate&sortOrder=descending`;

        const res = await globalThis.fetch(url, { headers });
        if (!res.ok) {
          return fetchArxivRssFallback(categories, maxItems, headers);
        }

        const xml = await res.text();
        const items = parseAtomFeed(xml);
        return items.length > 0 ? items : fetchArxivRssFallback(categories, maxItems, headers);
      } catch {
        return fetchArxivRssFallback(categories, maxItems, headers).catch(() => []);
      }
    }
  };
}

async function fetchArxivRssFallback(categories: string[], maxItems: number, headers: Record<string, string>) {
  const items: SourceItem[] = [];
  for (const category of categories) {
    const response = await globalThis.fetch(`${ARXIV_RSS_BASE}/${encodeURIComponent(category)}`, { headers });
    if (!response.ok) continue;
    items.push(...parseRssFeed(await response.text()));
    if (items.length >= maxItems) break;
  }
  return items.slice(0, maxItems);
}

function parseAtomFeed(xml: string): SourceItem[] {
  const items: SourceItem[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    if (!entryXml) continue;

    const title = stripHtml(extractTag(entryXml, "title"));
    const summary = stripHtml(extractTag(entryXml, "summary") || extractTag(entryXml, "content") || "");
    const published = extractTag(entryXml, "published") || extractTag(entryXml, "updated") || "";
    const link = extractTag(entryXml, "id") || "";
    const category = extractTag(entryXml, "category", "term");

    const authorMatch = entryXml.match(/<author>[\s\S]*?<name>(.*?)<\/name>/);
    const author = authorMatch?.[1] || "Unknown";

    if (title && link) {
      items.push({
        title,
        url: link,
        content: `${summary.slice(0, 500)}...\n\nAuthors: ${author}\nCategory: ${category}`,
        metadata: { published, author, category }
      });
    }
  }

  return items;
}

function parseRssFeed(xml: string): SourceItem[] {
  const items: SourceItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    if (!itemXml) continue;

    const title = stripHtml(extractTag(itemXml, "title"));
    const link = stripHtml(extractTag(itemXml, "link"));
    const description = stripHtml(extractTag(itemXml, "description"));
    const published = extractTag(itemXml, "dc:date") || extractTag(itemXml, "pubDate") || "";
    const category = [...itemXml.matchAll(/<category>([\s\S]*?)<\/category>/g)]
      .map((categoryMatch) => stripHtml(categoryMatch[1] ?? ""))
      .filter(Boolean)
      .join(", ");
    const authors = [...itemXml.matchAll(/<dc:creator>([\s\S]*?)<\/dc:creator>/g)]
      .map((authorMatch) => stripHtml(authorMatch[1] ?? ""))
      .filter(Boolean)
      .join(", ");

    if (title && link) {
      items.push({
        title,
        url: link,
        content: `${description.slice(0, 500)}...\n\nAuthors: ${authors || "Unknown"}\nCategory: ${category}`,
        metadata: {
          author: authors || "Unknown",
          category,
          published,
          source: "arxiv-rss"
        }
      });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string, attr?: string): string {
  if (attr) {
    const regex = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*>`);
    const match = xml.match(regex);
    return match?.[1] || "";
  }
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const match = xml.match(regex);
  return match?.[1]?.trim() || "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
