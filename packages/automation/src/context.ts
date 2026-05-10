import type { SourceItem } from "@zyquor/adapters";
import type { SourcePacket, TweetType } from "@zyquor/core";
import { buildSourceTweetInput } from "@zyquor/generation";
import type { ZyquorRepository } from "@zyquor/storage";

export interface AccountGenerationContext {
  bannedPhrases?: string[];
  objective?: string;
  systemPromptExtra?: string;
  tone: string | null;
}

export async function accountGenerationContext(
  repository: ZyquorRepository,
  accountId: string
): Promise<AccountGenerationContext> {
  const account = await repository.getAccount(accountId);
  const styleProfile = account ? await repository.getStyleProfile(account.styleProfileId) : null;
  const rules = styleProfile?.rules ?? {};

  return {
    ...(styleProfile?.bannedPhrases ? { bannedPhrases: styleProfile.bannedPhrases } : {}),
    ...(typeof rules.objective === "string" ? { objective: rules.objective } : {}),
    ...(typeof rules.systemPromptExtra === "string" ? { systemPromptExtra: rules.systemPromptExtra } : {}),
    tone: styleProfile?.tone ?? null
  };
}

export function articleTweetIdea(packet: Pick<SourcePacket, "facts" | "sourceType" | "summary" | "title" | "url">) {
  return buildSourceTweetInput(packet).idea;
}

export function sourceTweetInput(packet: Pick<SourcePacket, "facts" | "sourceType" | "summary" | "title" | "url">) {
  return buildSourceTweetInput(packet);
}

export function cleanSentence(value: string) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\\\//g, "/")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 $2")
    .replace(/\s+/g, " ")
    .replace(/\bSourcePacket\b/gi, "")
    .replace(/\bsource packet\b/gi, "")
    .trim();
}

export function truncateText(value: string, maxLength: number) {
  const clean = cleanSentence(value);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}.`;
}

export function packetFieldsFromItem(item: SourceItem) {
  const sentences = item.content
    .split(/(?<=[.!?])\s+/)
    .map(cleanSentence)
    .filter((sentence) => sentence.length >= 20 && !/^https?:\/\//i.test(sentence));
  const uniqueFacts = [...new Set([item.title, ...sentences])].map((fact) => truncateText(fact, 500));

  return {
    title: truncateText(item.title, 240),
    summary: truncateText(sentences[0] ?? item.content ?? item.title, 600),
    facts: uniqueFacts.slice(0, 5)
  };
}

export function inferTweetTypeFromText(item: SourceItem): TweetType {
  const source = typeof item.metadata?.source === "string" ? item.metadata.source : "";
  const type = typeof item.metadata?.type === "string" ? item.metadata.type : "";
  const title = item.title.toLowerCase();
  const content = item.content.toLowerCase();
  if (type === "hiring" || source.includes("hackernews-jobs") || /hiring|is hiring|we're hiring|jobs?/.test(title)) {
    return "hiring";
  }
  if (source === "company-rss" || /\b(blog|article|post|essay|guide)\b/i.test(title)) {
    return "article_summary";
  }
  if (
    /\b(history|invented|inventor|founded|founder|created|origin|born|died|legacy|anniversary|pioneer)\b/i.test(
      `${title} ${content}`
    )
  ) {
    return "narrative_history";
  }
  if (/how to|tutorial|guide/i.test(title)) return "guide";
  if (/mistake|wrong|lesson|learned/i.test(title)) return "lesson";
  if (/opinion|think|believe|should/i.test(title)) return "opinion";
  if (/tool|app|product|launch/i.test(title)) return "tool";
  if (/study|research|paper/i.test(content)) return "useful_info";
  return "feed_observation";
}
