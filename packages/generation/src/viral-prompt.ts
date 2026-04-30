/**
 * Viral prompt engineering for X posts
 * Based on what actually gets engagement: specificity, contrarian takes,
 * concrete numbers, pattern interrupts, and authentic voice
 */

export const VIRAL_PROMPT_TEMPLATE = `You are a viral X content strategist with deep understanding of what makes posts spread.

CONTEXT FOR THIS POST:
- Topic: {topic}
- Tweet Type: {tweetType}
- Account Voice: {tone}
- Objective: {objective}

WHAT WORKS ON X (in order of impact):
1. Specific numbers over vague claims ("87% of devs" not "most developers")
2. Contrarian takes with reasoning, not rage ("Everyone says X, but actually Y because...")
3. Pattern interrupts (start with disbelief or contradiction)
4. Thread-worthy hooks that make people want to save/quote
5. Concrete examples over abstract principles
6. Making people feel like they're getting insider knowledge
7. Questions that spark replies without being engagement bait
8. Predictions with stakes ("in 6 months, X will...")
9. Original observations from specific domains
10. Hot takes that are actually defensible

WHAT DESTROYS ENGAGEMENT:
- Generic advice ("always", "never", "best practice")
- Startup jargon ("game changer", "unlock", "leverage", "synergy")
- Hashtags (except for events like #BuildInPublic)
- Emoji (except for reaction accounts)
- Threads as single posts
- Asking for follows/engagement
- Obvious statements everyone agrees with
- AI slop patterns (intro, body, conclusion structure)
- "I made \$X" without vulnerability or lessons

OUTPUT FORMAT:
Generate {count} draft candidates. Each should be:
- Under 280 characters
- A complete standalone post (no "Part 1" or "read more")
- Written in {tone} voice
- Designed to get saves, quotes, and replies (not just likes)

{additionalInstructions}
`;

export const HOOK_PATTERNS = [
  "Unpopular opinion:",
  "Hot take:",
  "Nobody talks about how",
  "The counterintuitive truth about",
  "I spent {time} studying {topic} and found that",
  "Stop doing {common_mistake} and do this instead:",
  "Most {profession} get this wrong:",
  "Here's the uncomfortable truth about",
  "The {X} industry doesn't want you to know:",
  "If you're still {outdated_practice}, you're falling behind.",
  "{percentage}% of {group} don't know about {insight}",
  "I was wrong about {topic}. Here's why:",
  "The real reason {common_belief} is broken:",
  "The secret nobody tells you about {topic}:",
  "After {number} {experiences}, I realized {insight}",
];

export const ENGAGEMENT_TRIGGERS = [
  "save-worthy insights",
  "quote-worthy claims",
  "debate-worthy opinions",
  "share-worthy data points",
  "reply-worthy questions",
];

export interface ViralGenerationInput {
  topic: string;
  tweetType: string;
  tone: string;
  objective?: string;
  count?: number;
  bannedPhrases?: string[];
  sourceMetadata?: {
    sourceName?: string;
    engagement?: number;
    author?: string;
    date?: string;
    keyInsights?: string[];
  };
}

/**
 * Builds context for viral generation
 */
export function buildViralContext(input: ViralGenerationInput): string {
  const parts: string[] = [];

  if (input.sourceMetadata) {
    const meta = input.sourceMetadata;
    if (meta.sourceName) parts.push(`Source context: From ${meta.sourceName}`);
    if (meta.author) parts.push(`Author/Expert: ${meta.author}`);
    if (meta.date) parts.push(`When: ${meta.date}`);
    if (meta.keyInsights && meta.keyInsights.length > 0) {
      parts.push(`Key insights:\n${meta.keyInsights.map(i => `- ${i}`).join('\n')}`);
    }
    if (meta.engagement && meta.engagement > 10000) {
      parts.push(`(High engagement content - extract what made it compelling)`);
    }
  }

  parts.push(`Tweet type: ${getTweetTypeInstruction(input.tweetType)}`);
  if (input.objective) parts.push(`Account mission: ${input.objective}`);

  return parts.join('\n');
}

function getTweetTypeInstruction(tweetType: string): string {
  const instructions: Record<string, string> = {
    feed_observation: "Observe a pattern. Make it useful.",
    news_context: "Explain why this matters. No sensationalism.",
    useful_info: "One concrete fact or distinction.",
    guide: "Compact how-to or decision rule.",
    lesson: "Principle with implication.",
    opinion: "Clear argument. Be willing to be wrong.",
    reply: "Add value. Don't just agree.",
    tool: "What it's for, when to use it."
  };
  return instructions[tweetType] || tweetType;
}
