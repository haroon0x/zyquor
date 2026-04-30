export interface TweetSourceContext {
  author?: string | null;
  engagement?: number | null;
  facts?: string[];
  publishedAt?: string | null;
  sourceName?: string | null;
  title?: string | null;
  topicTags?: string[];
  url?: string | null;
}

export interface TweetGenerationHarnessInput {
  idea: string;
  source?: TweetSourceContext;
}

function compact(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function buildIdeaTweetInput(idea: string): TweetGenerationHarnessInput {
  return { idea: compact(idea) };
}

export function buildSourceTweetInput(input: {
  facts?: string[];
  summary: string;
  title: string;
  url?: string | null;
  sourceName?: string | null;
  publishedAt?: string | null;
  engagement?: number | null;
  topicTags?: string[];
}): TweetGenerationHarnessInput {
  const facts = [...new Set([input.title, ...(input.facts ?? [])])]
    .map(compact)
    .filter(Boolean)
    .slice(0, 8);

  return {
    idea: [
      `News headline: ${compact(input.title)}`,
      input.url ? `Original URL: ${input.url}` : null,
      `Known summary: ${compact(input.summary)}`,
      facts.length ? `Verified facts:\n${facts.map((fact) => `- ${fact}`).join("\n")}` : null,
      "Write a clean standalone tweet from this context. Do not mention internal processing, datasets, packets, summaries, prompts, or metadata."
    ]
      .filter(Boolean)
      .join("\n"),
    source: {
      engagement: input.engagement ?? null,
      facts,
      publishedAt: input.publishedAt ?? null,
      sourceName: input.sourceName ?? null,
      title: input.title,
      topicTags: input.topicTags ?? [],
      url: input.url ?? null
    }
  };
}

export function renderSourceContext(source: TweetSourceContext | undefined) {
  if (!source) return "";

  const lines = [
    source.sourceName ? `Source name: ${source.sourceName}` : null,
    source.title ? `Source title: ${source.title}` : null,
    source.url ? `Source URL: ${source.url}` : null,
    source.author ? `Author: ${source.author}` : null,
    source.publishedAt ? `Published: ${source.publishedAt}` : null,
    typeof source.engagement === "number" ? `Observed engagement score: ${source.engagement}` : null,
    source.topicTags?.length ? `Topic tags: ${source.topicTags.join(", ")}` : null,
    source.facts?.length ? `Grounded facts:\n${source.facts.map((fact) => `- ${fact}`).join("\n")}` : null
  ].filter(Boolean);

  return lines.length ? `\n\nSource context:\n${lines.join("\n")}` : "";
}
