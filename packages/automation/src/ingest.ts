import type { SourceAdapter } from "@zyquor/adapters";
import type { DraftGenerationProvider } from "@zyquor/generation";
import type { ZyquorRepository } from "@zyquor/storage";
import { packetFieldsFromItem } from "./context.js";
import { draftFromSourcePacket } from "./draft.js";
import { inferTweetTypeFromText } from "./context.js";
import { isSourceType, isWithinScheduleWindow, pickTweetType } from "./selection.js";

export interface IngestRunResult {
  configId: string;
  draftId: string;
  jobId: string | null;
  packetId: string;
  sourceType: string;
  url: string | null;
}

export interface RunAutomaticIngestOptions {
  adapters: Map<string, SourceAdapter>;
  generationProvider: DraftGenerationProvider;
  now?: Date;
  repository: ZyquorRepository;
}

const PREFERRED_NEWS_KEYWORDS = [
  "ai",
  "artificial intelligence",
  "llm",
  "agent",
  "agents",
  "automation",
  "model",
  "openai",
  "anthropic",
  "google",
  "meta",
  "microsoft",
  "apple",
  "nvidia",
  "chip",
  "chips",
  "semiconductor",
  "compute",
  "datacenter",
  "data center",
  "developer",
  "programming",
  "software",
  "open source",
  "database",
  "infrastructure",
  "security",
  "privacy",
  "cybersecurity",
  "startup",
  "saas",
  "cloud",
  "robotics",
  "science",
  "research",
  "study",
  "paper",
  "arxiv",
  "physics",
  "space",
  "climate",
  "biotech",
  "healthcare",
  "medicine",
  "drug",
  "battery",
  "nuclear",
  "economy",
  "economic",
  "gdp",
  "inflation",
  "interest rate",
  "federal reserve",
  "fed",
  "central bank",
  "jobs report",
  "unemployment",
  "markets",
  "stocks",
  "bonds",
  "yield",
  "crypto",
  "bitcoin",
  "tariff",
  "supply chain",
  "regulation",
  "policy",
  "antitrust",
  "geopolitical",
  "geopolitics",
  "china",
  "india",
  "europe",
  "taiwan",
  "trade",
  "energy",
  "defense",
  "war",
  "election",
  "business",
  "earnings",
  "revenue",
  "profit",
  "layoffs",
  "funding",
  "acquisition",
  "ipo",
  "merger"
];

function sourceRelevanceScore(item: { content: string; title: string }) {
  const text = `${item.title} ${item.content}`.toLowerCase();
  return PREFERRED_NEWS_KEYWORDS.reduce((score, keyword) => score + (text.includes(keyword) ? 1 : 0), 0);
}

function prioritizeSourceItems<T extends { content: string; title: string }>(items: T[]) {
  return [...items].sort((a, b) => sourceRelevanceScore(b) - sourceRelevanceScore(a));
}

export async function runAutomaticIngest(options: RunAutomaticIngestOptions) {
  const configs = await options.repository.listIngestConfigs();
  const enabled = configs.filter((config) => config.enabled);
  const results: IngestRunResult[] = [];
  const errors: Array<{ configId: string; error: string }> = [];
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);

  for (const config of enabled) {
    try {
      if (!isWithinScheduleWindow(config.scheduleWindowStart, config.scheduleWindowEnd, options.now)) {
        continue;
      }

      const packets = await options.repository.listSourcePackets(config.accountId);
      const todayPackets = packets.filter((packet) => packet.sourceType === config.sourceType && packet.createdAt.startsWith(today));
      if (todayPackets.length >= config.maxPacketsPerDay) {
        continue;
      }

      const adapter = options.adapters.get(config.sourceType);
      if (!adapter || !isSourceType(config.sourceType)) {
        continue;
      }

      const remaining = config.maxPacketsPerDay - todayPackets.length;
      const items = prioritizeSourceItems(await adapter.fetch(config.metadata));

      for (const item of items.slice(0, remaining)) {
        const existing = item.url ? await options.repository.getSourcePacketByUrl(item.url, config.accountId) : null;
        if (existing) continue;

        const { summary, facts } = packetFieldsFromItem(item);
        const tweetType = pickTweetType(config.tweetTypeMix, inferTweetTypeFromText(item));
        const packet = await options.repository.createSourcePacket({
          accountId: config.accountId,
          facts,
          sourceType: config.sourceType,
          summary,
          title: item.title,
          tweetType,
          url: item.url
        });
        const drafted = await draftFromSourcePacket({
          generationProvider: options.generationProvider,
          packet,
          repository: options.repository,
          options: {
            autoApprove: true,
            count: 1,
            ...(item.imageUrl ? { mediaUrls: [item.imageUrl] } : {}),
            mode: "autopost"
          }
        });

        results.push({
          configId: config.id,
          draftId: drafted.draft.id,
          jobId: drafted.approved ? drafted.approved.job.id : null,
          packetId: packet.id,
          sourceType: packet.sourceType,
          url: packet.url
        });
      }
    } catch (error) {
      errors.push({
        configId: config.id,
        error: error instanceof Error ? error.message : "Unknown ingest error"
      });
    }
  }

  return { errors, processed: results.length, results };
}
