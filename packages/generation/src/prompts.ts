import { AI_SLOP_PHRASES } from "@zyquor/core";
import { renderSourceContext } from "./harness.js";
import { characterLimit, DEFAULT_CHARACTER_LIMIT, normalizeCount } from "./quality.js";
import type { GenerateDraftCandidatesInput } from "./types.js";

const AUTHENTICITY_RULES = [
  "Sound human: plain words, one useful point, no corporate or ad voice.",
  "Start with substance, never 'just', 'so', or 'ok so'. No throat-clearing, hook formulas, colon-led setups ('here's the thing:'), or 'it's not X, it's Y'.",
  "Post-processing lowercases text. Write lowercase-compatible prose, never use capitals for emphasis; proper nouns and acronyms are fine.",
  "No engagement-bait question at the end. Give opinions a reason and end on a concrete implication.",
  "Use simple punctuation. Reserve line breaks, '-' lists, and '>' timelines for content that needs them."
];

const VOICE_EXAMPLES = [
  "Voice calibration. These pairs show tone and shape only. Never reuse their facts, topics, or wording.",
  "Weak: 'AI tools will change coding forever.'",
  "Strong: 'our 6-person team capped prs at 200 lines; median review time fell from 2 hours to 35 minutes.'",
  "Weak: 'Startups should talk to users more.'",
  "Strong: '7 customer calls brought 43 signups. a week of scheduled posts brought 2.'",
  "Weak: 'This database changes everything.'",
  "Strong: 'sqlite served 8 million rows on a $20 server; write contention forced the postgres move.'"
];

const PUNCTUATION_RULES = [
  "Never use em or en dashes (— or –)."
];

export function tweetTypeInstruction(tweetType: string | undefined) {
  if (!tweetType) {
    return "General value post: state one useful fact or claim and why it matters.";
  }

  const labels: Record<string, string> = {
    feed_observation:
      "Feed observation: write in first person, name a supplied pattern, and make one clear claim about it. No hedging; 'imo' is fine, 'i think maybe' is not.",
    news_context:
      "News context: give the second-order implication, including who is affected and what changes. Do not restate the headline.",
    useful_info:
      "Useful info: lead with one supplied fact or distinction, then state its practical use or consequence.",
    guide:
      "Guide: give 2-3 compact, actionable steps or one decision rule grounded in supplied details. No generic checklist.",
    lesson:
      "Lesson: tie one learned principle to a supplied event or example, then say what to do differently. No fortune-cookie moral.",
    opinion:
      "Opinion: write in first person and make one clear claim with its reason. No hedging; 'imo' is fine, 'i think maybe' is not.",
    reply:
      "Reply: reference the author's point concretely and add one useful fact, correction, or experience. Never restate the post or give 'great post!' energy.",
    tool:
      "Tool: name the tool, the exact task it helps with, and when to use it; include a supplied limitation or tradeoff when present.",
    hiring:
      "Hiring: include the role, company, one supplied detail such as stack, location, or compensation, the exact source link, and the disclosure 'sharing, not affiliated'.",
    article_summary:
      "Article summary: give the one useful takeaway in your own words plus the exact link. Vary openings: takeaway first; 'i'd read this for [insight]'; '[result] is the part worth keeping.'",
    narrative_history:
      "Narrative history: build a compact arc from verified dates, names, and events, then close on their consequence. '>' timeline lines are optional. Never invent causality or attribution."
  };

  return labels[tweetType] ?? `${tweetType}: state one supplied fact or claim and why it matters.`;
}

function normalizeIdea(idea: string) {
  return idea.trim().replace(/\s+/g, " ");
}

function formatExamplePosts(examplePosts: string[] | undefined) {
  if (!examplePosts?.length) return "";
  const posts = examplePosts
    .map((post) => post.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((post) => `> ${post.slice(0, DEFAULT_CHARACTER_LIMIT).replace(/\n/g, "\n> ")}`)
    .join("\n");
  return [
    "Account calibration examples. Use these instead of the generic pairs for voice only; never copy their facts, topics, or wording:",
    posts
  ].join("\n");
}

function formatRecentHistory(history: string[] | undefined) {
  if (!history?.length) return "";
  const lines = history
    .map((post) => post.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((post, index) => `${index + 1}. ${post.slice(0, 60)}${post.length > 60 ? "..." : ""}`)
    .join("\n");
  return [
    "Recent posts. Avoid repeating their angles or phrasing:",
    lines
  ].join("\n");
}

export function systemPrompt(input: GenerateDraftCandidatesInput) {
  const count = normalizeCount(input.count);
  const bannedPhrases = [...new Set([...AI_SLOP_PHRASES, ...(input.bannedPhrases ?? [])])].join(",");
  const limit = characterLimit(input);
  const voiceNotes = input.systemPromptExtra?.trim() ?? "";
  const voiceNoteLines = voiceNotes.split(/\r?\n/);
  const examplesHeadingIndex = voiceNoteLines.findIndex((line) => /examples/i.test(line));
  const voiceNotesHaveExamples =
    examplesHeadingIndex >= 0 &&
    voiceNoteLines.slice(examplesHeadingIndex + 1).some((line) => /^(?:-\s+|\d+[.)]\s+)/.test(line.trimStart()));
  const diversityInstruction =
    count >= 3
      ? "Use distinct substantive angles: key fact and meaning; who is affected; practical implication. Do not return paraphrases."
      : "Give each candidate a distinct substantive angle, not a paraphrase.";
  return [
    "Role",
    "Write public X post candidates in the account owner's voice. Write text only.",
    "Non-negotiable rules",
    "Never decide whether or when to post, rank candidates, fetch or browse anything, or claim to have opened a link.",
    `Write complete, standalone public text, never teasers or thread continuations. Maximum ${limit} characters per candidate.`,
    "Use only supplied facts. Each candidate needs a specific fact, number, name, or example from the input. Never invent details or causality; narrow thin claims.",
    "For source-backed posts, preserve the exact supplied URL and use only the supplied <source-title> for attribution.",
    "No hashtags unless the idea contains one. No emojis unless the idea contains one. Never write 'thread 🧵'.",
    "Never expose internal terms such as SourcePacket, source context, candidate, draft, metadata, JSON, prompt, or grounded facts.",
    `Never use these AI-slop or account-banned phrases: ${bannedPhrases}.`,
    "Voice",
    ...AUTHENTICITY_RULES,
    ...PUNCTUATION_RULES,
    "Tweet type",
    tweetTypeInstruction(input.tweetType),
    "Calibration examples",
    input.examplePosts?.length
      ? formatExamplePosts(input.examplePosts)
      : voiceNotesHaveExamples
        ? "Use the example tweets in Account voice notes instead of the generic calibration pairs."
        : VOICE_EXAMPLES.join("\n"),
    "User style",
    `Tone: ${input.tone?.trim() || "clear, useful, direct"}.`,
    input.objective?.trim() ? `Objective: ${input.objective.trim()}.` : "",
    formatRecentHistory(input.recentPostHistory),
    voiceNotes
      ? `Account voice notes${voiceNotesHaveExamples ? " (example tweets below override the generic calibration pairs)" : ""}:\n${voiceNotes}`
      : "",
    "Output format",
    diversityInstruction,
    `Return exactly ${count} non-empty candidates as strict JSON only: {"candidates":[{"text":"first draft"},{"text":"second draft"}]}.`
  ]
    .filter(Boolean)
    .join("\n");
}

export function userPrompt(input: GenerateDraftCandidatesInput) {
  const replyInstruction = input.replyContext
    ? `You are drafting a reply to @${input.replyContext.authorHandle}'s post at ${input.replyContext.url}. Write a useful reply using the user's description of the target post below. Do not claim to have opened or read the linked post.`
    : "";
  return `${replyInstruction ? `${replyInstruction}\n\n` : ""}Context to turn into public X posts:\n${normalizeIdea(input.idea)}${renderSourceContext(input.context)}`;
}

export function linePrompt(input: GenerateDraftCandidatesInput) {
  const count = normalizeCount(input.count);
  const limit = characterLimit(input);
  return [
    `Write exactly ${count} concise X post drafts about this idea: ${normalizeIdea(input.idea)}`,
    tweetTypeInstruction(input.tweetType),
    input.replyContext
      ? `You are drafting a reply to @${input.replyContext.authorHandle}'s post at ${input.replyContext.url}. Write a useful reply using the user's description of the target post. Do not claim to have opened or read the linked post.`
      : "",
    `Each draft must be ${limit} characters or fewer.`,
    "One draft per line.",
    "No numbering, no labels, no JSON.",
    "Each line takes a different angle on the idea, not a paraphrase.",
    "Write like a person typing one useful thought. Include a supplied fact, number, name, or example; no pure vibes.",
    "Never start with 'just', 'so', or 'ok so'. No hook formulas, colon-led setups, engagement-bait endings, or 'thread 🧵'.",
    "Write naturally lowercase-compatible text; never rely on capitals for emphasis.",
    "Never mention SourcePacket, source packet, compact input, candidate, draft, metadata, prompt, or distillation.",
    "Use only supplied facts. Never fetch, rank, schedule, or decide whether to post.",
    "No hashtags unless the idea contains one. No emojis unless the idea contains one.",
    `Never use these AI-slop or account-banned phrases: ${[...new Set([...AI_SLOP_PHRASES, ...(input.bannedPhrases ?? [])])].join(",")}.`,
    ...PUNCTUATION_RULES
  ].filter(Boolean).join("\n");
}
