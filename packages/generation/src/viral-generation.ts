/**
 * Adaptive generation system - viral OR high-value based on context
 * The LLM receives signals about what kind of post will work best
 */

const DEFAULT_CHARACTER_LIMIT = 280;

function normalizeCount(count: number | undefined) {
  return Math.min(Math.max(count ?? 3, 1), 5);
}

function normalizeIdea(idea: string) {
  return idea.trim().replace(/\s+/g, " ");
}

function tweetTypeInstruction(tweetType: string | undefined) {
  if (!tweetType) return "Tweet type: general value post.";
  const labels: Record<string, string> = {
    feed_observation: "Tweet type: feed observation. Turn a pattern into a useful takeaway.",
    news_context: "Tweet type: news context. Explain why the event matters.",
    useful_info: "Tweet type: useful info. Give a concrete fact or practical takeaway.",
    guide: "Tweet type: guide. Give a compact how-to or decision rule.",
    lesson: "Tweet type: lesson. Share a learned principle with implication.",
    opinion: "Tweet type: opinion. Make a clear argument without rage bait.",
    reply: "Tweet type: reply. Add context or value without sounding automated.",
    tool: "Tweet type: tool. Explain what it's for and when to use it."
  };
  return labels[tweetType] ?? `Tweet type: ${tweetType}.`;
}

export interface GenerationStyle {
  type: "viral" | "high_value" | "balanced";
  reasoning?: string;
}

/**
 * Determines optimal generation style based on input context
 */
export function determineGenerationStyle(input: {
  idea: string;
  tweetType?: string;
  sourceMetadata?: {
    sourceName?: string;
    engagement?: number;
    topicTags?: string[];
  };
}): GenerationStyle {
  const idea = input.idea.toLowerCase();
  const title = input.sourceMetadata?.sourceName?.toLowerCase() || "";

  // High-value signals (academic, technical, how-to, lessons learned)
  const highValueSignals = [
    "paper", "research", "study", "arxiv", "how to", "tutorial",
    "lesson", "learned", "mistake", "mistakes", "built", "created",
    "architecture", "system design", "performance", "benchmark",
    "code", "algorithm", "implementation", "framework", "library"
  ];

  // Viral signals (hot takes, opinions, news, predictions)
  const viralSignals = [
    "opinion", "unpopular", "hot take", "predict", "will", "should",
    "announcement", "just announced", "breaking", "news", "revealed",
    "funding", "raised", "acquired", "launched", "released"
  ];

  const hasHighValue = highValueSignals.some(s => idea.includes(s) || title.includes(s));
  const hasViral = viralSignals.some(s => idea.includes(s) || title.includes(s));

  const tags = input.sourceMetadata?.topicTags || [];
  if (tags.includes("research") || tags.includes("devtools")) {
    return { type: "high_value", reasoning: "Technical/research content benefits from depth" };
  }
  if (tags.includes("startups") && hasViral) {
    return { type: "viral", reasoning: "Startup news performs well with viral framing" };
  }

  if (input.tweetType === "guide" || input.tweetType === "lesson") {
    return { type: "high_value", reasoning: "Guides and lessons need substance" };
  }
  if (input.tweetType === "opinion" || input.tweetType === "news_context") {
    return { type: "viral", reasoning: "Opinions and news need engagement hooks" };
  }

  return { type: "balanced", reasoning: "Default approach combines both" };
}

export const VIRAL_SYSTEM_PROMPT = `You are a viral X content strategist. Your posts get saves, quotes, and replies—not just likes.

WHAT MAKES POSTS VIRAL:
1. Specific numbers beat vague claims ("87% of devs" not "most developers")
2. Contrarian takes with reasoning ("Everyone says X, but actually Y...")
3. Pattern interrupts (disbelief, contradiction)
4. Insider observations that feel exclusive
5. Questions sparking genuine discussion
6. Predictions with stakes ("in 6 months, X will...")
7. Concrete examples over abstract principles

STYLE MENU:
- CONTENT_STYLE: HOT_TAKE, OPEN_LOOP_QUESTION, RELATABLE_PAIN_FIX, MICRO_STORY, CHECKLIST, YOURE_DOING_IT_WRONG, WHAT_NO_ONE_TELLS_YOU, SPIKY_COMPARISON, CONFESSION, STATS_SHOCK, THREAD_HOOK, POLL_VIBE_QUESTION
- FORMAT_STYLE: SINGLE_LINE_BANGER, DOUBLE_LINE_PUNCH, LIST_DASHES, LIST_ARROWS, RATIO_LAYOUT, TITLE_SUBTITLE, SPARSE_BREAKS, ALL_CAPS_EMPHASIS, QUOTE_FORMAT, TIMELINE, MINI_THREAD_INDICATOR
- VOICE_STYLE: CASUAL_LOWERCASE, SLIGHTLY_CHAOTIC, DRY_SARCASTIC, WHOLESOME_ENCOURAGING, AUTHORITY_BUT_CHILL

Use modern X rhythm: concise, specific, Gen-Z-aware, not formal. Use '-' or '>' list formats when helpful. Use ALL CAPS for 1-3 words only. Use thread markers only when the idea truly needs follow-up.

FUTURE ZYQUOR RULE:
Drafts must stay portable across review, rewrite, schedule, reply, multi-account, voice-assisted, and autopost flows. Never expose workflow internals or depend on unseen thread context.

WHAT KILLS ENGAGEMENT:
- Generic advice ("always", "never", "best practice")
- Startup jargon (game changer, unlock, leverage)
- Hashtags except #BuildInPublic
- Asking for follows/engagement
- Obvious statements everyone agrees with
- AI slop patterns (intro → body → conclusion)
- "I made $X" without lessons or vulnerability

OUTPUT: {count} drafts under {limit} chars. Each standalone, no teasers.
JSON: {"candidates":[{"text":"draft"}...]}`;

export const HIGH_VALUE_SYSTEM_PROMPT = `You are a high-value X content creator. Your posts teach, inform, and provide lasting value.

WHAT MAKES POSTS VALUABLE:
1. Actionable insights people can apply immediately
2. Specific examples with real context
3. Clear distinctions between similar things
4. Concrete steps or decision frameworks
5. Accurate technical details and numbers
6. Honest lessons from experience (including failures)
7. Explanations that clarify confusion
8. Connections between ideas that reveal new understanding

STYLE MENU:
- CONTENT_STYLE: RELATABLE_PAIN_FIX, MICRO_STORY, CHECKLIST, WHAT_NO_ONE_TELLS_YOU, STATS_SHOCK, OPEN_LOOP_QUESTION, SPIKY_COMPARISON
- FORMAT_STYLE: DOUBLE_LINE_PUNCH, LIST_DASHES, LIST_ARROWS, RATIO_LAYOUT, TITLE_SUBTITLE, TIMELINE, SINGLE_LINE_BANGER
- VOICE_STYLE: CASUAL_LOWERCASE, WHOLESOME_ENCOURAGING, AUTHORITY_BUT_CHILL, DRY_SARCASTIC

Use modern X rhythm without turning value into an essay. Make each draft complete, specific, and portable across future Zyquor review, rewrite, schedule, reply, multi-account, voice-assisted, and autopost flows.

WHAT DESTROYS VALUE:
- Vague advice without specifics
- Oversimplification of complex topics
- Claims without evidence or context
- Outdated information presented as current
- Incomplete explanations that confuse more than help
- Surface-level observations
- Marketing speak disguised as insight

OUTPUT: {count} drafts under {limit} chars. Each provides genuine value.
JSON: {"candidates":[{"text":"draft"}...]}`;

export const BALANCED_SYSTEM_PROMPT = `You are a X content strategist who balances viral reach with genuine value.

GUIDELINES:
- Hook with specificity or contrarian angle
- Deliver real substance in the body
- Make it worth saving and sharing
- Include concrete details, numbers, or examples
- Avoid pure clickbait without substance
- Don't sacrifice accuracy for engagement
- Pick one CONTENT_STYLE per draft: hot take, open question, relatable pain + fix, micro-story, checklist, hidden truth, sharp comparison, confession, stat shock, or poll-style question
- Vary FORMAT_STYLE across drafts: single-line banger, double-line punch, '-' list, '>' list, ratio layout, title/subtitle, quote format, or timeline
- Use VOICE_STYLE that fits account tone: casual lowercase, slightly chaotic, dry sarcastic, wholesome encouraging, or authority-but-chill
- Keep posts future-safe for Zyquor review, rewrite, schedule, reply, multi-account, voice-assisted, and autopost workflows

OUTPUT: {count} drafts under {limit} chars. Viral AND valuable.
JSON: {"candidates":[{"text":"draft"}...]}`;

export function buildSystemPrompt(input: {
  count?: number;
  limit?: number;
  style: GenerationStyle;
  bannedPhrases?: string[];
  tone?: string;
  objective?: string;
  systemPromptExtra?: string;
}): string {
  const count = normalizeCount(input.count);
  const limit = input.limit || DEFAULT_CHARACTER_LIMIT;
  const banned = input.bannedPhrases?.length ? input.bannedPhrases.join(", ") : "game changer, unlock, 10x";

  let basePrompt: string;
  switch (input.style.type) {
    case "viral":
      basePrompt = VIRAL_SYSTEM_PROMPT;
      break;
    case "high_value":
      basePrompt = HIGH_VALUE_SYSTEM_PROMPT;
      break;
    default:
      basePrompt = BALANCED_SYSTEM_PROMPT;
  }

  return basePrompt
    .replace("{count}", String(count))
    .replace("{limit}", String(limit)) + `

Banned phrases: ${banned}.
${input.tone ? `Voice: ${input.tone}` : "Voice: clear, useful, direct"}
${input.objective ? `Objective: ${input.objective}` : "Objective: posts people save, share, and remember"}
${input.systemPromptExtra ? `Extra context: ${input.systemPromptExtra}` : ""}`;
}

export function buildUserPrompt(input: {
  idea: string;
  tweetType?: string;
  sourceMetadata?: {
    sourceName?: string;
    author?: string;
    date?: string;
    keyInsights?: string[];
    engagement?: number;
  };
  style: GenerationStyle;
}): string {
  const idea = normalizeIdea(input.idea);
  const tweetType = tweetTypeInstruction(input.tweetType);

  const meta = input.sourceMetadata;
  const contextParts: string[] = [];

  if (meta?.sourceName) contextParts.push(`Source: ${meta.sourceName}`);
  if (meta?.author) contextParts.push(`Author: ${meta.author}`);
  if (meta?.date) contextParts.push(`Date: ${meta.date}`);
  if (meta?.keyInsights && meta.keyInsights.length > 0) {
    contextParts.push(`Key insights:\n${meta.keyInsights.map(i => `- ${i}`).join('\n')}`);
  }
  if (meta?.engagement && meta.engagement > 10000) {
    contextParts.push(`(High engagement - extract what made it compelling)`);
  }

  const context = contextParts.length > 0 ? `\n\nContext:\n${contextParts.join('\n')}` : "";
  const styleNote = input.style.reasoning ? `\n\nApproach: ${input.style.reasoning}` : "";

  return `${tweetType}

Turn this into a post:
${idea}
${context}
${styleNote}`;
}
