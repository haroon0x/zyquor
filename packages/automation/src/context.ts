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
    summary: truncateText(sentences[0] ?? item.content ?? item.title, 600),
    facts: uniqueFacts.slice(0, 5)
  };
}

export function inferTweetTypeFromText(item: SourceItem): TweetType {
  const title = item.title.toLowerCase();
  const content = item.content.toLowerCase();
  if (/how to|tutorial|guide/i.test(title)) return "guide";
  if (/mistake|wrong|lesson|learned/i.test(title)) return "lesson";
  if (/opinion|think|believe|should/i.test(title)) return "opinion";
  if (/tool|app|product|launch/i.test(title)) return "tool";
  if (/study|research|paper/i.test(content)) return "useful_info";
  return "feed_observation";
}
