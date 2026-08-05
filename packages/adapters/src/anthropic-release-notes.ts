import type { SourceAdapter, SourceItem } from "./types.js";

const RELEASE_NOTES_URL = "https://docs.anthropic.com/en/release-notes";

export interface AnthropicReleaseNotesAdapterOptions {
  maxItems?: number;
}

export function createAnthropicReleaseNotesAdapter(options: AnthropicReleaseNotesAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 8;

  return {
    name: "anthropic-release-notes",
    sourceType: "anthropic-release-notes",
    async fetch(): Promise<SourceItem[]> {
      try {
        const res = await globalThis.fetch(RELEASE_NOTES_URL, { headers: { "User-Agent": "Zyquor/1.0" } });
        if (!res.ok) return [];
        return parseEntries(await res.text()).slice(0, maxItems);
      } catch {
        return [];
      }
    }
  };
}

function parseEntries(html: string): SourceItem[] {
  const parts = html.split(/<h2 class="font-heading text-primary">/).slice(1);
  const items: SourceItem[] = [];
  for (const part of parts) {
    const anchor = firstMatch(part, /id="([^"]+)"/);
    const published = parseDate(firstMatch(part, /([A-Z][a-z]+ \d{1,2}, \d{4})/) ?? "");
    if (!anchor || !published) continue;
    const lines = cleanLines(part);
    const titleLine = lines.find(
      (line) =>
        !/^\d{1,2},\s*\d{4}$/.test(line) &&
        line.length <= 80 &&
        /[A-Za-z]/.test(line)
    );
    if (!titleLine) continue;
    const title = titleLine;
    const content = [...new Set(lines.filter((line) => line !== title && line.length >= 30))].join(" ").slice(0, 3000);
    items.push({
      title,
      url: `${RELEASE_NOTES_URL}#${anchor}`,
      content: content || title,
      metadata: { published, source: "anthropic-release-notes" }
    });
  }
  return items;
}

function cleanLines(html: string): string[] {
  return stripTags(html)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);
}

function firstMatch(value: string, pattern: RegExp): string | null {
  const match = value.match(pattern);
  return match && match[1] ? match[1] : null;
}

function stripTags(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, "\n");
}

function parseDate(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
