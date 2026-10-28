export type GenerationProviderName = "command-code" | "opencode" | "openrouter" | "gemini" | "ollama";

export interface GenerateDraftCandidatesInput {
  bannedPhrases?: string[];
  context?: import("./harness.js").TweetSourceContext;
  examplePosts?: string[];
  feedback?: string;
  idea: string;
  count?: number;
  memoryContext?: string;
  objective?: string;
  preserveCase?: boolean;
  recentPostHistory?: string[];
  replyContext?: { authorHandle: string; url: string; authorName?: string; text?: string; otherReplies?: string[] };
  systemPromptExtra?: string;
  systemFeedback?: string[];
  tone?: string | null;
  tweetType?: string;
  accountKnowledge?: Array<{ kind: string; title: string; content: string }>;
}

export interface GeneratedDraftCandidate {
  text: string;
  score: Record<string, unknown>;
}

export interface DraftGenerationProvider {
  name: GenerationProviderName;
  model: string;
  generateDraftCandidates(input: GenerateDraftCandidatesInput): Promise<GeneratedDraftCandidate[]>;
}

export interface GenerationProviderConfig {
  provider: GenerationProviderName;
  model: string;
  configured: boolean;
  baseUrl?: string;
  revisionPass?: boolean;
}

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}
