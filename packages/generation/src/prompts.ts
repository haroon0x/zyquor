import { AI_SLOP_PHRASES } from "@zyquor/core";
import type { TweetType } from "@zyquor/core";
import { renderSourceContext } from "./harness.js";
import { characterLimit, DEFAULT_CHARACTER_LIMIT, normalizeCount } from "./quality.js";
import type { GenerateDraftCandidatesInput } from "./types.js";

const AUTHENTICITY_RULES = [
  "Human voice: plain words, one useful point, no corporate/ad tone.",
  "Start with fact/claim, never: interesting; a/quick/friendly reminder; this shows; fun fact; breaking/just in; did you know; imagine/picture this/in a world; just/so/ok so.",
  "No formula hooks/filler: colon setup; unlock/leverage/synergy; now more than ever; here's the thing/kicker/why; why this matters; best part?; hot take/unpopular opinion; nobody/no one talks about; let that sink in/read that again; mind-blowing; this changes everything/the future is here; it's not X, it's Y; X isn't just Y, it's Z.",
  "Lowercase-compatible; no capitals for emphasis. Proper nouns/acronyms are fine.",
  "Use nouns/verbs, not promo adjectives: exciting/thrilling/groundbreaking/revolutionary/disruptive/innovative/cutting-edge/state-of-the-art/powerful/robust/seamless/effortless/comprehensive/holistic/impactful/strategic/dynamic/scalable.",
  "No LinkedIn voice: thrilled/excited/honored/humbled/proud/grateful/blessed; journey; big/exciting news; pleased/excited to announce; thought leadership; key takeaways.",
  "End on result/implication, never bait, thoughts?/agree?, wild/huge/insane, etc., ellipsis, or trailing so/and/but/or.",
  "Simple punctuation. Use line breaks, '-' lists, or '>' timelines only when needed."
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
  "Never use em or en dashes (— or –); use commas or full stops."
];
const PROMPT_AI_SLOP_PHRASES = AI_SLOP_PHRASES.filter(
  (phrase) => !AI_SLOP_PHRASES.some((shorter) => shorter !== phrase && phrase.includes(shorter))
);

function bannedPhraseList(extra: string[] | undefined) {
  return [...new Set([...PROMPT_AI_SLOP_PHRASES, ...(extra ?? [])])].join(",");
}

export function tweetTypeInstruction(tweetType: string | undefined) {
  if (!tweetType) {
    return "General value post: state one useful fact or claim and why it matters.";
  }

  const guidance: Record<TweetType, { instruction: string; exemplar: string }> = {
    feed_observation: {
      instruction: "Feed observation: write in first person, name a supplied pattern, and make one clear claim about it. No hedging; 'imo' is fine, 'i think maybe' is not.",
      exemplar: "i've watched 3 teams add queues before measuring one timeout. each queue made the failure harder to trace."
    },
    news_context: {
      instruction: "News context: give the second-order implication, including who is affected and what changes. Do not restate the headline.",
      exemplar: "cutting review time from 5 days to 1 matters most to small teams: security fixes can reach users inside the same sprint."
    },
    useful_info: {
      instruction: "Useful info: lead with one supplied fact or distinction, then state its practical use or consequence.",
      exemplar: "a 10-minute cache removed half the reads without making stale data a product problem."
    },
    guide: {
      instruction: "Guide: give 2-3 compact, actionable steps or one decision rule grounded in supplied details. No generic checklist.",
      exemplar: "before adding a queue: measure peak writes, cap retries, then kill one worker and inspect recovery."
    },
    lesson: {
      instruction: "Lesson: tie one learned principle to a supplied event or example, then say what to do differently. No fortune-cookie moral.",
      exemplar: "we cut deploys from 40 minutes to 8 by removing two approval hops. audit the process before replacing the build."
    },
    tool: {
      instruction: "Tool: name the tool, the exact task it helps with, and when to use it; include a supplied limitation or tradeoff when present.",
      exemplar: "ripgrep is my first stop for a rename across a large repo. it finds references fast, but it does not understand symbols."
    },
    opinion: {
      instruction: "Opinion: write in first person and make one clear claim with its reason. No hedging; 'imo' is fine, 'i think maybe' is not.",
      exemplar: "i'd rather ship one boring endpoint with an error budget than five abstractions nobody can trace."
    },
    reply: {
      instruction: "Reply: reference the author's point concretely and add one useful fact, correction, or experience. Never restate the post or give 'great post!' energy.",
      exemplar: "the rollback detail is the key: retries are safe only when the write is idempotent."
    },
    hiring: {
      instruction: "Hiring: include the role, company, one supplied detail such as stack, location, or compensation, the exact source link, and the disclosure 'sharing, not affiliated'.",
      exemplar: "fieldnote is hiring a backend engineer in berlin, €90k-€110k, typescript + postgres: https://example.com/role\n\nsharing, not affiliated"
    },
    article_summary: {
      instruction: "Article summary: one useful takeaway in your words plus the exact link. Open with the takeaway, 'i'd read this for [insight]', or '[result] is worth keeping.'",
      exemplar: "useful result: capping work in progress cut delivery time 18%. https://example.com/study"
    },
    narrative_history: {
      instruction: "Narrative history: build a compact arc from verified dates, names, and events, then close on their consequence. '>' timeline lines are optional. Never invent causality or attribution.",
      exemplar: "in 2012, a two-person team shipped cedar from a spare room. by 2015, 40 clinics used it. support, not code, became the constraint."
    }
  };

  const selected = guidance[tweetType as TweetType];
  return selected
    ? `${selected.instruction} Style reference only; never copy facts/wording: "${selected.exemplar}"`
    : `${tweetType}: state one supplied fact or claim and why it matters.`;
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
    .map((post, index) => `${index + 1}. ${post.slice(0, 40)}${post.length > 40 ? "..." : ""}`)
    .join("\n");
  return [
    "Recent posts. Avoid repeating their angles or phrasing:",
    lines
  ].join("\n");
}

export function systemPrompt(input: GenerateDraftCandidatesInput) {
  const count = normalizeCount(input.count);
  const bannedPhrases = bannedPhraseList(input.bannedPhrases);
  const limit = characterLimit(input);
  const voiceNotes = input.systemPromptExtra?.trim() ?? "";
  const voiceNoteLines = voiceNotes.split(/\r?\n/);
  const examplesHeadingIndex = voiceNoteLines.findIndex((line) => /examples/i.test(line));
  const voiceNotesHaveExamples =
    examplesHeadingIndex >= 0 &&
    voiceNoteLines.slice(examplesHeadingIndex + 1).some((line) => /^(?:-\s+|\d+[.)]\s+)/.test(line.trimStart()));
  const diversityInstruction =
    input.tweetType === "opinion" && count >= 3
      ? "Use distinct forms supported by context. Possible forms include a direct claim, concrete mechanism or example, rejected approach and failure, or personal choice, tradeoff, or consequence. If context supports one form, anchor each candidate in a different supplied detail. Never invent a missing form or fact. Do not return paraphrases."
      : count >= 3
      ? "Use distinct substantive angles: key fact and meaning; who is affected; practical implication. Do not return paraphrases."
      : "Give each candidate a distinct substantive angle, not a paraphrase.";
  return [
    "Role",
    "Write public X posts in the account owner's voice. Text only.",
    "Non-negotiable rules",
    "Never rank, schedule, fetch/browse, decide whether to post, or claim link access.",
    `Standalone posts only, no teasers/thread continuations. Maximum ${limit} characters each.`,
    "Use supplied facts only. Never add names, tools, dates, quantities, examples, comparisons, or causal claims absent from context; generalize unsupported detail.",
    "Source-backed posts: include every supplied URL exactly in every candidate; attribute only with supplied <source-title>.",
    "No hashtags/emoji unless the idea contains them. Never write 'thread 🧵'.",
    "Never expose internal terms: SourcePacket, source context, candidate/draft, metadata, JSON, prompt, grounded facts.",
    "Every post must give an unfamiliar reader a standalone fact, observation, decision rule, or clear claim. Never assume they know the account owner or an internal project.",
    "Never mention Zyquor or turn instructions about its source ingestion, memory, prompts, drafting, automation, or content workflow into a post topic. External tools and workflows explicitly supplied as the public topic are allowed.",
    `Banned AI/account phrases, never use: ${bannedPhrases}.`,
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
        : input.tweetType
          ? "Use the tweet-type style reference above."
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
  return `${replyInstruction ? `${replyInstruction}\n\n` : ""}Allowed factual context to turn into public X posts:\n<provided-context>\n${normalizeIdea(input.idea)}${renderSourceContext(input.context)}\n</provided-context>`;
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
    "Open with substance, not 'interesting', 'a reminder', 'this shows', 'fun fact', 'breaking', 'just in', 'imagine', 'picture this', 'in a world', 'just', 'so', or 'ok so'.",
    "No hook formulas, colon-led setups, promotional adjective piles, LinkedIn announcement voice, engagement-bait endings, weak trailing words, or 'thread 🧵'.",
    "Write naturally lowercase-compatible text; never rely on capitals for emphasis.",
    "Never mention SourcePacket, source packet, compact input, candidate, draft, metadata, prompt, or distillation.",
    "Use only supplied facts. Do not add named tools, dates, quantities, benchmarks, workflows, measurements, or examples absent from the idea. Never fetch, rank, schedule, or decide whether to post.",
    "No hashtags unless the idea contains one. No emojis unless the idea contains one.",
    `Banned AI/account phrases, never use: ${bannedPhraseList(input.bannedPhrases)}.`,
    ...PUNCTUATION_RULES
  ].filter(Boolean).join("\n");
}
