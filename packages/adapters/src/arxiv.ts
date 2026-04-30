import type { SourceAdapter, SourceItem } from "./types.js";

const ARXIV_API = "http://export.arxiv.org/api/query";

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
      try {
        const url = `${ARXIV_API}?search_query=${encodeURIComponent(searchQuery)}&start=0&max_results=${maxItems}&sortBy=submittedDate&sortOrder=descending`;

        const res = await globalThis.fetch(url, { headers: { "User-Agent": "Zyquor/1.0" } });
        if (!res.ok) return [];

        const xml = await res.text();
        return parseAtomFeed(xml);
      } catch {
        return [];
      }
    }
  };
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
    .replace(/\s+/g, " ")
    .trim();
}
