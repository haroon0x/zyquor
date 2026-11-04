import { spawn } from "node:child_process";
import type { SourceAdapter, SourceItem } from "./types.js";

function defaultWindowsMcpPath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) return localAppData + "\\Goldfish\\goldfish-mcp.exe";
  const userProfile = process.env.USERPROFILE;
  if (userProfile) return userProfile + "\\AppData\\Local\\Goldfish\\goldfish-mcp.exe";
  return "goldfish-mcp.exe";
}

export interface GoldfishAdapterOptions {
  maxItems?: number;
  mode?: "chronicle" | "working_memory" | "recent";
  query?: string;
  allowedKeywords?: string[];
}

export function goldfishMcpCommand(): string[] {
  if (process.platform === "win32") {
    return [defaultWindowsMcpPath()];
  }
  return ["powershell.exe", "-NoProfile", "-Command", defaultWindowsMcpPath()];
}

export async function callGoldfishTool<T>(tool: string, params: Record<string, unknown>): Promise<T> {
  const cmd = goldfishMcpCommand();
  const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  const payload = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: params } }),
  ].join("\n") + "\n";
  child.stdin.write(payload);
  child.stdin.end();
  const result = await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Goldfish MCP timeout"));
    }, 15000);
    child.on("close", () => {
      clearTimeout(timeout);
      const lines = stdout.split("\n").filter(Boolean);
      for (const line of lines) {
        if (line.startsWith("[goldfish")) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 2 && parsed.result) {
            const content = parsed.result.content?.[0]?.text;
            if (content) {
              try { resolve(JSON.parse(content)); return; } catch { resolve(content as T); return; }
            }
            if (parsed.result.structuredContent) { resolve(parsed.result.structuredContent as T); return; }
            resolve(parsed.result as T);
            return;
          }
        } catch {}
      }
      if (stderr.includes("proxy to http")) {
        reject(new Error("Goldfish MCP no result"));
      } else {
        reject(new Error(`Goldfish MCP failed: ${stderr.slice(0, 500)}`));
      }
    });
    child.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function chronicleToItems(chronicle: { summary_text?: string; period_key?: string; snapshot_count?: number }, maxItems: number): SourceItem[] {
  const text = (chronicle.summary_text ?? "").trim();
  if (!text) return [];
  const chunks = text.split(/\n\n+/).filter(Boolean).slice(0, maxItems);
  return chunks.map((chunk, idx) => {
    const title = chunk.split("\n")[0]?.slice(0, 80) ?? `Goldfish chronicle ${chronicle.period_key}`;
    return {
      title: title.replace(/^\[.*?\]\s*/, "").slice(0, 120) || `Personal activity ${chronicle.period_key}`,
      url: `goldfish://chronicle/${chronicle.period_key ?? "today"}/${idx}`,
      content: chunk.slice(0, 3000),
      metadata: { period: chronicle.period_key, snapshot_count: chronicle.snapshot_count, source: "goldfish-chronicle" },
    };
  });
}

function workingMemoryToItems(memory: Array<{ content: string; app: string; window_title: string; url?: string | null }>, maxItems: number): SourceItem[] {
  const items: SourceItem[] = [];
  for (const snap of memory.slice(0, maxItems)) {
    const content = (snap.content ?? "").trim();
    if (content.length < 80) continue;
    if (content.includes("Goldfish — AI memory")) continue;
    items.push({
      title: snap.window_title?.slice(0, 120) || snap.app,
      url: snap.url ?? `goldfish://snapshot/${snap.app}`,
      content: content.slice(0, 3000),
      metadata: { app: snap.app, window_title: snap.window_title, source: "goldfish-memory" },
    });
  }
  return items;
}

export function createGoldfishAdapter(options: GoldfishAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 5;
  const mode = options.mode ?? "chronicle";
  const query = options.query;

  return {
    name: "goldfish",
    sourceType: "goldfish",
    async fetch(configMetadata?: Record<string, unknown>): Promise<SourceItem[]> {
      // Normalize keywords: trim, lowercase, dedupe. Config overrides options.
      const rawKeywords = Array.isArray(configMetadata?.allowedKeywords) ? configMetadata.allowedKeywords : options.allowedKeywords;
      const allowedKeywords = Array.isArray(rawKeywords)
        ? [...new Set((rawKeywords as unknown[]).filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim().toLowerCase()))]
        : [];
      const shouldFilter = allowedKeywords.length > 0;
      const keywordPatterns = shouldFilter ? allowedKeywords.map((k) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(k)}([^a-z0-9]|$)`, "i")) : [];

      const passesFilter = (item: SourceItem) => {
        if (!shouldFilter) return true;
        const text = `${item.title} ${item.content}`;
        return keywordPatterns.some((p) => p.test(text));
      };
      const filterAndSlice = (items: SourceItem[]) => {
        if (!shouldFilter) return items.slice(0, maxItems);
        return items.filter(passesFilter).slice(0, maxItems);
      };

      // Over-fetch when filtering so slice-after-filter still yields maxItems (capped 50).
      const poolSize = shouldFilter ? Math.min(50, maxItems * 3) : maxItems;
      const recentLimit = shouldFilter ? Math.max(12, poolSize) : 12;

      try {
        if (mode === "recent") {
          const recent = await callGoldfishTool<unknown>("get_recent_activity", { minutes: 60, limit: recentLimit });
          let raw: Array<{ content: string; app: string; window_title: string; url?: string }> = [];
          if (Array.isArray(recent)) {
            raw = recent as Array<{ content: string; app: string; window_title: string; url?: string }>;
          } else {
            const recentObj = recent as { events?: Array<{ content_excerpt: string; app: string; window_title: string; url?: string }> };
            if (recentObj.events && Array.isArray(recentObj.events)) {
              raw = recentObj.events.map((e) => ({ content: e.content_excerpt, app: e.app, window_title: e.window_title, url: e.url }));
            }
          }
          return filterAndSlice(workingMemoryToItems(raw, poolSize));
        }
        if (query) {
          const result = await callGoldfishTool<{ results?: Array<{ content_excerpt: string; window_title: string; url?: string; app: string }> } | Array<{ content_excerpt: string }>>(
            "search_memory",
            { query, limit: poolSize },
          );
          const arr = Array.isArray(result) ? result : (result as { results?: unknown[] })?.results ?? [];
          const candidates = (arr as Array<{ content_excerpt: string; window_title: string; url?: string; app: string }>)
            .map((r, i) => ({
              title: r.window_title?.slice(0, 120) || `Goldfish memory ${i}`,
              url: r.url ?? `goldfish://search/${encodeURIComponent(query)}/${i}`,
              content: (r.content_excerpt ?? "").slice(0, 3000),
              metadata: { app: r.app, source: "goldfish-search" },
            }))
            .filter((it) => it.content.length > 40);
          return filterAndSlice(candidates);
        }
        if (mode === "working_memory") {
          const mem = await callGoldfishTool<Array<{ content: string; app: string; window_title: string; url?: string }>>("get_working_memory", {
            limit: shouldFilter ? poolSize : maxItems * 2,
          });
          return filterAndSlice(workingMemoryToItems(Array.isArray(mem) ? mem : [], poolSize));
        }
        const today = new Date().toISOString().slice(0, 10);
        const chronicle = await callGoldfishTool<{ summary_text: string; period_key: string; snapshot_count: number }>("get_chronicle", {
          level: "day",
          period: today,
        });
        if (chronicle && (chronicle as { summary_text?: string }).summary_text) {
          const candidates = chronicleToItems(chronicle as { summary_text?: string; period_key?: string; snapshot_count?: number }, poolSize);
          const filtered = filterAndSlice(candidates);
          if (filtered.length > 0) return filtered;
          // fall through when chronicle filtered to empty
        }
        const mem = await callGoldfishTool<Array<{ content: string; app: string; window_title: string }>>("get_working_memory", {
          limit: shouldFilter ? poolSize : maxItems * 2,
        });
        return filterAndSlice(workingMemoryToItems(Array.isArray(mem) ? mem : [], poolSize));
      } catch {
        return [];
      }
    },
  };
}
