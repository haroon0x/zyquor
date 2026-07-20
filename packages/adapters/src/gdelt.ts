import type { SourceAdapter, SourceItem } from "./types.js";

const GDELT_CONTEXT_API = "https://api.gdeltproject.org/api/v2/context/context";

export interface GdeltAdapterOptions {
  maxItems?: number;
  timeoutMs?: number;
  topic: string;
}

export function createGdeltAdapter(options: GdeltAdapterOptions): SourceAdapter {
  const maxItems = options.maxItems ?? 20;
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    name: "gdelt-context",
    sourceType: "news",
    async fetch(): Promise<SourceItem[]> {
      const query = gdeltQuery(options.topic);
      if (!query) return [];
      const url = new URL(GDELT_CONTEXT_API);
      url.searchParams.set("query", query);
      url.searchParams.set("mode", "artlist");
      url.searchParams.set("format", "json");
      url.searchParams.set("maxrecords", String(Math.min(Math.max(maxItems, 1), 75)));
      url.searchParams.set("timespan", "48h");
      url.searchParams.set("sort", "datedesc");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        let response: Response;
        try {
          response = await fetchGdelt(url, controller.signal);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          response = await fetchGdelt(url, controller.signal);
        }
        if (response.status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 6_000));
          response = await fetchGdelt(url, controller.signal);
        }
        if (!response.ok) return [];
        const body = (await response.json()) as { articles?: GdeltArticle[] };
        return (body.articles ?? [])
          .filter((article) => !article.language || article.language.toLowerCase() === "english")
          .map((article) => articleToSourceItem(article))
          .filter((item): item is SourceItem => item !== null);
      } catch {
        return [];
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}

function fetchGdelt(url: URL, signal: AbortSignal) {
  return globalThis.fetch(url, {
    headers: { "User-Agent": "Zyquor/1.0" },
    signal
  });
}

function gdeltQuery(topic: string) {
  const words = topic
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3)
    .slice(0, 5);
  if (words.length === 0) return "";
  return words.length === 1 ? words[0]! : `near20:\"${words.join(" ")}\"`;
}

function articleToSourceItem(article: GdeltArticle): SourceItem | null {
  const title = article.title?.trim();
  const url = article.url?.trim();
  const published = gdeltTimestamp(article.seendate);
  if (!title || !url || !published) return null;
  const content = article.context?.trim() || article.sentence?.trim() || title;
  return {
    title,
    url,
    content,
    metadata: {
      domain: article.domain ?? null,
      published,
      source: "gdelt-context"
    }
  };
}

function gdeltTimestamp(value: string | undefined) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value ?? "");
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

interface GdeltArticle {
  context?: string;
  domain?: string;
  language?: string;
  seendate?: string;
  sentence?: string;
  title?: string;
  url?: string;
}
