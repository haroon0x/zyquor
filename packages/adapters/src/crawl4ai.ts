import type { CrawlService } from "./types.js";

export interface Crawl4AiOptions {
  apiUrl?: string;
  timeoutMs?: number;
}

export function createCrawl4AiService(options: Crawl4AiOptions = {}): CrawlService {
  const apiUrl = options.apiUrl || process.env.CRAWL4AI_API_URL || "http://127.0.0.1:11235/crawl";
  const timeoutMs = options.timeoutMs ?? 30000;

  return {
    async crawl(url: string): Promise<{ markdown: string; metadata?: Record<string, unknown> }> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await globalThis.fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url }),
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!res.ok) {
          throw new Error(`Crawl4AI returned ${res.status}`);
        }

        const data = await res.json() as {
          markdown?: string;
          text?: string;
          content?: string;
          metadata?: Record<string, unknown>;
        };

        return {
          markdown: (data.markdown || data.text || data.content || "").trim(),
          ...(data.metadata ? { metadata: data.metadata } : {})
        };
      } catch (error) {
        clearTimeout(timeout);
        throw error;
      }
    }
  };
}
