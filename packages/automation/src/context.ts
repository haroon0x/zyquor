import type { SourceItem } from "@zyquor/adapters";
import type { SourcePacket, TweetType } from "@zyquor/core";
import { buildSourceTweetInput } from "@zyquor/generation";
import type { ZyquorRepository } from "@zyquor/storage";

export interface AccountGenerationContext {
  bannedPhrases?: string[];
  examplePosts?: string[];
  objective?: string;
  recentPostHistory?: string[];
  systemPromptExtra?: string;
  systemFeedback?: string[];
  tone: string | null;
}

export async function accountGenerationContext(
  repository: ZyquorRepository,
  accountId: string
): Promise<AccountGenerationContext> {
  const account = await repository.getAccount(accountId);
  const styleProfile = account ? await repository.getStyleProfile(account.styleProfileId) : null;
  const rules = styleProfile?.rules ?? {};
  const history = await repository.listPostHistory();
  const systemFeedback = await repository.listSystemFeedback(accountId);

  return {
    ...(styleProfile?.bannedPhrases ? { bannedPhrases: styleProfile.bannedPhrases } : {}),
    ...(styleProfile?.examplePosts?.length ? { examplePosts: styleProfile.examplePosts } : {}),
    ...(typeof rules.objective === "string" ? { objective: rules.objective } : {}),
    ...(typeof rules.systemPromptExtra === "string" ? { systemPromptExtra: rules.systemPromptExtra } : {}),
    ...(systemFeedback.length ? { systemFeedback: systemFeedback.slice(0, 5).map((item) => item.text) } : {}),
    tone: styleProfile?.tone ?? null,
    recentPostHistory: history
      .filter((item) => item.accountId === accountId)
      .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt))
      .slice(0, 10)
      .map((item) => item.postedText)
  };
}

export function articleTweetIdea(packet: Pick<SourcePacket, "facts" | "sourceType" | "summary" | "title" | "url">) {
  const title = cleanSentence(packet.title).slice(0, 240);
  const facts = [...new Set(packet.facts.map((fact) => cleanSentence(fact)))]
    .filter((fact) => fact && fact.toLowerCase() !== title.toLowerCase())
    .slice(0, 5)
    .map((fact) => fact.slice(0, 400));
  return [
    title ? `Title: ${title}` : null,
    packet.url ? `URL: ${packet.url}` : null,
    `Summary: ${cleanSentence(packet.summary).slice(0, 1200)}`,
    facts.length ? `Facts:\n${facts.map((fact) => `- ${fact}`).join("\n")}` : null
  ]
    .filter(Boolean)
    .join("\n");
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
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, " ")
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

export function packetFieldsFromFeedDigest(item: SourceItem) {
  const lines = item.content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const uniqueLines = [...new Set(lines)];

  return {
    title: truncateText(item.title, 240),
    summary: truncateText(uniqueLines.join(" · "), 2000),
    facts: uniqueLines.slice(0, 8).map((line) => truncateText(line, 500))
  };
}

export function hasEnoughSourceContext(input: { facts: string[]; summary: string; title: string }) {
  const title = cleanSentence(input.title).toLowerCase();
  const facts = [...new Set(input.facts.map((fact) => cleanSentence(fact).toLowerCase()))]
    .filter((fact) => fact.length >= 20 && fact !== title);
  const summary = cleanSentence(input.summary).toLowerCase();
  return facts.length >= 2 || (facts.length >= 1 && summary.length >= 80 && summary !== title);
}

export function inferTweetTypeFromText(item: SourceItem): TweetType {
  const source = typeof item.metadata?.source === "string" ? item.metadata.source : "";
  const type = typeof item.metadata?.type === "string" ? item.metadata.type : "";
  const title = item.title.toLowerCase();
  const content = item.content.toLowerCase();
  if (type === "hiring" || source.includes("hackernews-jobs") || /hiring|is hiring|we're hiring|jobs?/.test(title)) {
    return "useful_info";
  }
  if (source === "company-rss" || /\b(blog|article|post|essay|guide)\b/i.test(title)) {
    return "useful_info";
  }
  if (
    /\b(history|invented|inventor|founded|founder|created|origin|born|died|legacy|anniversary|pioneer)\b/i.test(
      `${title} ${content}`
    )
  ) {
    return "narrative_history";
  }
  if (/how to|tutorial|guide/i.test(title)) return "guide";
  if (/mistake|wrong|lesson|learned/i.test(title)) return "guide";
  if (/opinion|think|believe|should/i.test(title)) return "opinion";
  if (/tool|app|product|launch/i.test(title)) return "useful_info";
  if (/study|research|paper/i.test(content)) return "useful_info";
  return "useful_info";
}
