import type { SourceAdapter, SourceItem } from "./types.js";

const HN_API_BASE = "https://hacker-news.firebaseio.com/v0";

export interface HiringAdapterOptions {
  maxItems?: number;
}

export function createHiringAdapter(options: HiringAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 10;

  return {
    name: "hiring-hackernews",
    sourceType: "job",
    async fetch(): Promise<SourceItem[]> {
      try {
        const response = await globalThis.fetch(`${HN_API_BASE}/jobstories.json`);
        if (!response.ok) return [];
        const ids = (await response.json()) as number[];
        const items: SourceItem[] = [];

        for (const id of ids.slice(0, maxItems)) {
          const item = await fetchHiringItem(id);
          if (item) {
            items.push(item);
          }
        }

        return items;
      } catch {
        return [];
      }
    }
  };
}

async function fetchHiringItem(id: number): Promise<SourceItem | null> {
  try {
    const response = await globalThis.fetch(`${HN_API_BASE}/item/${id}.json`);
    if (!response.ok) return null;
    const item = (await response.json()) as HackerNewsJobItem;
    if (!item.title) return null;

    const url = item.url || `https://news.ycombinator.com/item?id=${id}`;
    const body = stripHtml(item.text ?? "");
    return {
      title: item.title,
      url,
      content: [
        item.title,
        body,
        "Verified hiring source: Hacker News job post.",
        "Post should say the account is not affiliated and is sharing the opportunity."
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: {
        author: item.by ?? null,
        published: item.time ? new Date(item.time * 1000).toISOString() : null,
        source: "hackernews-jobs",
        sourceId: id,
        type: "hiring"
      }
    };
  } catch {
    return null;
  }
}

function stripHtml(value: string) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

interface HackerNewsJobItem {
  by?: string;
  text?: string;
  time?: number;
  title?: string;
  url?: string;
}
