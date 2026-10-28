import { callGoldfishTool } from "./goldfish.js";

export interface GoldfishContextInput {
  authorHandle?: string;
  authorName?: string;
  tweetText?: string;
  maxWiki?: number;
  maxMemories?: number;
}

export interface GoldfishContextBundle {
  terms: string[];
  wiki: Array<{ slug: string; title: string; type: string; summary: string }>;
  memories: Array<{ app: string; capturedAt: string; title: string; excerpt: string }>;
}

const WIKI_LIMIT = 4;
const MEMORY_LIMIT = 5;
const DEFAULT_MAX_WIKI = 2;
const DEFAULT_MAX_MEMORIES = 3;
const KEYWORD_LIMIT = 4;
const TERM_LIMIT = 6;
const WIKI_SUMMARY_CAP = 300;
const MEMORY_EXCERPT_CAP = 280;
const RENDER_CAP = 1600;
const CONTEXT_CACHE_TTL_MS = 10 * 60 * 1000;
const CONTEXT_CACHE_MISS_TTL_MS = 60 * 1000;
const CONTEXT_CACHE_LIMIT = 50;

const STOPWORDS = new Set([
  "about", "after", "again", "also", "been", "before", "being", "between", "both",
  "com", "could", "does", "done", "down", "each", "even", "every", "from", "have",
  "here", "http", "https", "into", "just", "like", "made", "make", "many", "more",
  "most", "much", "must", "never", "only", "other", "over", "same", "should", "since",
  "some", "still", "such", "than", "that", "their", "them", "then", "there", "these",
  "they", "this", "those", "through", "under", "until", "very", "were", "what", "when",
  "where", "which", "while", "with", "will", "would", "www", "your"
]);

function normalizeHandle(value: string | undefined): string {
  return (value ?? "").trim().replace(/^@+/, "");
}

function keywordsFromText(text: string | undefined): string[] {
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const token of (text ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < 4) continue;
    if (/^\d+$/.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= KEYWORD_LIMIT) break;
  }
  return keywords;
}

export function deriveGoldfishTerms(input: GoldfishContextInput): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    const term = (value ?? "").trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key) || terms.length >= TERM_LIMIT) return;
    seen.add(key);
    terms.push(term);
  };

  const handle = normalizeHandle(input.authorHandle);
  push(handle);
  const name = (input.authorName ?? "").trim();
  if (name && name.toLowerCase() !== handle.toLowerCase()) {
    push(name);
  }
  for (const keyword of keywordsFromText(input.tweetText)) {
    push(keyword);
  }
  return terms;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function listFrom(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const record = asRecord(result);
  if (!record) return [];
  for (const key of ["results", "pages", "items"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function textField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function mapWikiResults(result: unknown, limit: number): GoldfishContextBundle["wiki"] {
  if (limit <= 0) return [];
  const items: GoldfishContextBundle["wiki"] = [];
  for (const raw of listFrom(result)) {
    const record = asRecord(raw);
    if (!record) continue;
    const title = textField(record, ["title", "name", "slug"]);
    const summary = textField(record, ["summary", "description"]).slice(0, WIKI_SUMMARY_CAP);
    if (!title || !summary) continue;
    items.push({
      slug: textField(record, ["slug", "id"]) || title,
      title,
      type: textField(record, ["type", "kind"]) || "topic",
      summary
    });
    if (items.length >= limit) break;
  }
  return items;
}

function mapMemoryResults(result: unknown, limit: number): GoldfishContextBundle["memories"] {
  if (limit <= 0) return [];
  const items: GoldfishContextBundle["memories"] = [];
  for (const raw of listFrom(result)) {
    const record = asRecord(raw);
    if (!record) continue;
    const excerpt = textField(record, ["content_excerpt", "content", "excerpt"]).slice(0, MEMORY_EXCERPT_CAP);
    if (!excerpt) continue;
    items.push({
      app: textField(record, ["app", "domain"]) || "unknown",
      capturedAt: textField(record, ["captured_at", "capturedAt"]),
      title: textField(record, ["window_title", "title"]) || excerpt.slice(0, 80),
      excerpt
    });
    if (items.length >= limit) break;
  }
  return items;
}

// Bulk drafting (mentions scan) re-runs the same handle + terms lookups within
// minutes, which would otherwise spawn a fresh goldfish MCP process per draft.
// Cache resolved bundles (and recent nulls) keyed by normalized handle + terms.
const contextCache = new Map<string, { value: GoldfishContextBundle | null; expiresAt: number }>();

export function clearGoldfishContextCache(): void {
  contextCache.clear();
}

function contextCacheKey(input: GoldfishContextInput): string {
  const handle = normalizeHandle(input.authorHandle).toLowerCase();
  const terms = deriveGoldfishTerms(input).map((term) => term.toLowerCase());
  // Limits are part of the key: a wiki-only lookup (maxMemories 0) must never
  // hit a cached bundle that still carries activity memories.
  return JSON.stringify([handle, terms, input.maxWiki ?? null, input.maxMemories ?? null]);
}

function cachedBundle(key: string): GoldfishContextBundle | null | undefined {
  const entry = contextCache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    contextCache.delete(key);
    return undefined;
  }
  // Refresh insertion order so the LRU cap evicts the oldest entry.
  contextCache.delete(key);
  contextCache.set(key, entry);
  return entry.value;
}

function storeBundle(key: string, value: GoldfishContextBundle | null): void {
  if (contextCache.size >= CONTEXT_CACHE_LIMIT) {
    const oldest = contextCache.keys().next().value;
    if (oldest !== undefined) {
      contextCache.delete(oldest);
    }
  }
  contextCache.set(key, {
    value,
    expiresAt: Date.now() + (value === null ? CONTEXT_CACHE_MISS_TTL_MS : CONTEXT_CACHE_TTL_MS)
  });
}

export async function fetchGoldfishReplyContext(input: GoldfishContextInput): Promise<GoldfishContextBundle | null> {
  let key = "";
  try {
    key = contextCacheKey(input);
    const cached = cachedBundle(key);
    if (cached !== undefined) {
      return cached;
    }
    const terms = deriveGoldfishTerms(input);
    // A zero limit means the caller wants none of that source: skip the RPC.
    const wikiLimit = input.maxWiki ?? DEFAULT_MAX_WIKI;
    const memoryLimit = input.maxMemories ?? DEFAULT_MAX_MEMORIES;
    const wikiQuery = wikiLimit <= 0 ? "" : (input.authorName ?? "").trim() || normalizeHandle(input.authorHandle);
    const memoryQuery = memoryLimit <= 0 ? "" : terms.join(" ");
    const [wikiResult, memoryResult] = await Promise.allSettled([
      wikiQuery
        ? callGoldfishTool<unknown>("search_wiki", { query: wikiQuery, limit: WIKI_LIMIT })
        : Promise.reject(new Error("goldfish wiki query unavailable")),
      memoryQuery
        ? callGoldfishTool<unknown>("search_memory", { query: memoryQuery, limit: MEMORY_LIMIT })
        : Promise.reject(new Error("goldfish memory query unavailable"))
    ]);

    if (wikiResult.status === "rejected" && memoryResult.status === "rejected") {
      storeBundle(key, null);
      return null;
    }

    const bundle: GoldfishContextBundle = {
      terms,
      wiki: wikiResult.status === "fulfilled" ? mapWikiResults(wikiResult.value, input.maxWiki ?? DEFAULT_MAX_WIKI) : [],
      memories:
        memoryResult.status === "fulfilled"
          ? mapMemoryResults(memoryResult.value, input.maxMemories ?? DEFAULT_MAX_MEMORIES)
          : []
    };
    storeBundle(key, bundle);
    return bundle;
  } catch {
    if (key) {
      storeBundle(key, null);
    }
    return null;
  }
}

export function renderGoldfishMemory(bundle: GoldfishContextBundle): string {
  if (bundle.wiki.length === 0 && bundle.memories.length === 0) return "";
  const lines = ["Personal memory from the account owner's own machine:"];
  for (const item of bundle.wiki) {
    lines.push(`- Wiki [${item.type}] ${item.title}: ${item.summary}`);
  }
  for (const item of bundle.memories) {
    lines.push(`- Activity (${item.app}, ${item.capturedAt}): ${item.title}: ${item.excerpt}`);
  }

  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    const projected = kept.length === 0 ? line.length : length + 1 + line.length;
    if (projected > RENDER_CAP) break;
    kept.push(line);
    length = projected;
  }
  return kept.join("\n");
}
