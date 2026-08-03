import type { SourceAdapter, SourceItem } from "./types.js";

export interface ModelReleasesAdapterOptions {
  maxItems?: number;
  now?: Date;
}

const MAX_SOURCE_AGE_MS = 48 * 60 * 60 * 1000;

export function createModelReleasesAdapter(options: ModelReleasesAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 20;

  return {
    name: "model-releases",
    sourceType: "model-releases",
    async fetch(): Promise<SourceItem[]> {
      const now = options.now ?? new Date();
      const settled = await Promise.allSettled([
        fetchOpenRouterModels(),
        fetchHuggingFaceModels(now),
        fetchSimonWillison()
      ]);
      const items: SourceItem[] = [];
      for (const result of settled) {
        if (result.status === "fulfilled") items.push(...result.value);
      }
      return items
        .filter((item) => {
          const raw = item.metadata?.published;
          if (typeof raw !== "string") return false;
          const publishedAt = Date.parse(raw);
          if (!Number.isFinite(publishedAt)) return false;
          const age = now.getTime() - publishedAt;
          return age >= -5 * 60 * 1000 && age <= MAX_SOURCE_AGE_MS;
        })
        .sort((a, b) => {
          const aTime = Date.parse(String(a.metadata?.published ?? 0));
          const bTime = Date.parse(String(b.metadata?.published ?? 0));
          return bTime - aTime;
        })
        .slice(0, maxItems);
    }
  };
}

interface OpenRouterModel {
  id: string;
  name: string;
  created: number;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

async function fetchOpenRouterModels(): Promise<SourceItem[]> {
  const res = await globalThis.fetch("https://openrouter.ai/api/v1/models", {
    headers: { "User-Agent": "Zyquor/1.0" }
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: OpenRouterModel[] };
  const items: SourceItem[] = [];
  for (const model of body.data ?? []) {
    const promptPerM = Number(model.pricing?.prompt ?? 0) * 1_000_000;
    const completionPerM = Number(model.pricing?.completion ?? 0) * 1_000_000;
    const published = new Date(model.created * 1000).toISOString();
    items.push({
      title: model.name || model.id,
      url: `https://openrouter.ai/${model.id}`,
      content:
        `Released on OpenRouter ${new Date(model.created * 1000).toISOString().slice(0, 10)}. ` +
        `Model id: ${model.id}. Context length: ${model.context_length ?? "unknown"} tokens. ` +
        `Pricing: $${promptPerM.toFixed(2)} per 1M input tokens, $${completionPerM.toFixed(2)} per 1M output tokens.`,
      metadata: { published, source: "openrouter" }
    });
  }
  return items;
}

interface HuggingFaceModel {
  id: string;
  createdAt: string;
  downloads: number;
  likes: number;
  pipeline_tag: string | null;
  tags: string[];
  private: boolean;
  gated: boolean;
}

async function fetchHuggingFaceModels(now: Date): Promise<SourceItem[]> {
  const url = new URL("https://huggingface.co/api/models");
  url.searchParams.set("sort", "createdAt");
  url.searchParams.set("direction", "-1");
  url.searchParams.set("limit", "40");
  const res = await globalThis.fetch(url, { headers: { "User-Agent": "Zyquor/1.0" } });
  if (!res.ok) return [];
  const body = (await res.json()) as HuggingFaceModel[];
  const items: SourceItem[] = [];
  for (const model of body) {
    if (model.private || model.gated) continue;
    if (model.likes < 1 && model.downloads < 10) continue;
    const age = now.getTime() - Date.parse(model.createdAt);
    if (age > MAX_SOURCE_AGE_MS) break;
    const facts = [
      `Released on Hugging Face ${model.createdAt.slice(0, 10)}.`,
      `Model id: ${model.id}.`,
      model.pipeline_tag ? `Task: ${model.pipeline_tag}.` : "",
      `Downloads: ${model.downloads}. Likes: ${model.likes}.`,
      `Tags: ${(model.tags ?? []).slice(0, 12).join(", ")}.`
    ].filter(Boolean).join(" ");
    items.push({
      title: model.id,
      url: `https://huggingface.co/${model.id}`,
      content: facts,
      metadata: { published: model.createdAt, source: "huggingface" }
    });
  }
  return items;
}

async function fetchSimonWillison(): Promise<SourceItem[]> {
  const res = await globalThis.fetch("https://simonwillison.net/atom/everything/", {
    headers: { "User-Agent": "Zyquor/1.0" }
  });
  if (!res.ok) return [];
  const xml = await res.text();
  const entries: SourceItem[] = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entryXml = match[1];
    if (!entryXml) continue;
    const title = decodeXml(extractXmlTag(entryXml, "title"));
    const link = decodeXml(extractXmlTag(entryXml, "link", "href") || extractXmlTag(entryXml, "link"));
    const content = decodeXml(stripHtml(extractXmlTag(entryXml, "content") || extractXmlTag(entryXml, "summary")));
    const published = decodeXml(extractXmlTag(entryXml, "published") || extractXmlTag(entryXml, "updated"));
    if (!title || !link) continue;
    entries.push({
      title,
      url: link,
      content: content || title,
      ...(published ? { metadata: { published, source: "simonwillison" } } : {})
    });
  }
  return entries;
}

function extractXmlTag(xml: string, tag: string, attribute?: string): string {
  const pattern = attribute
    ? new RegExp(`<${tag}[^>]*\\s${attribute}=["']([^"']+)["'][^>]*>`, "i")
    : new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const match = xml.match(pattern);
  if (!match) return "";
  return (match[1] ?? "").trim();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}
