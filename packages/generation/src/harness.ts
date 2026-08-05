export interface TweetSourceContext {
  author?: string | null;
  engagement?: number | null;
  facts?: string[];
  publishedAt?: string | null;
  sourceName?: string | null;
  sourceType?: string | null;
  summary?: string | null;
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
  sourceType?: string | null;
}): TweetGenerationHarnessInput {
  const title = compact(input.title).toLowerCase();
  const isXFeed = input.sourceType === "x-feed";
  const facts = [...new Set(input.facts ?? [])]
    .map(compact)
    .filter((fact) => fact && (isXFeed || fact.toLowerCase() !== title))
    .slice(0, isXFeed ? 20 : 5);

  return {
    idea: [
      isXFeed
        ? `Recent posts from the X home feed. Each numbered line is a separate post:\n${facts.map((fact, index) => `${index + 1}. ${fact}`).join("\n")}`
        : input.sourceType === "job"
          ? `Hiring post: ${compact(input.title)}`
          : `Source title: ${compact(input.title)}`,
      !isXFeed && input.url ? `Required source link: <source-url>${input.url}</source-url>` : null,
      !isXFeed ? `Known summary: ${compact(input.summary)}` : null,
      !isXFeed && facts.length ? `Verified facts:\n${facts.map((fact) => `- ${fact}`).join("\n")}` : null,
      isXFeed
        ? "Write a clean standalone observation based on these posts. Do not quote, name, or link any specific post or author; the post must make sense on its own with no reference at all."
        : "Write a clean standalone tweet from this context. Do not include the source link in the post body; the system appends the exact link at the end; reference at least one concrete fact above. Never paste the source title into the post."
    ]
      .filter(Boolean)
      .join("\n"),
    source: {
      engagement: input.engagement ?? null,
      facts,
      publishedAt: input.publishedAt ?? null,
      sourceName: input.sourceName ?? null,
      sourceType: input.sourceType ?? null,
      summary: compact(input.summary),
      title: compact(input.title),
      topicTags: input.topicTags ?? [],
      url: isXFeed ? null : input.url ?? null
    }
  };
}

export function renderSourceContext(
  source: TweetSourceContext | undefined,
  options: { includeMetadata?: boolean } = {}
) {
  if (!source) return "";

  if (options.includeMetadata === false) {
    const lines = [
      source.title ? `Title: ${compact(source.title).slice(0, 240)}` : null,
      source.url ? `URL: ${source.url}` : null,
      source.sourceType === "x-feed" ? null : source.summary ? `Summary: ${compact(source.summary).slice(0, 1200)}` : null,
      source.facts?.length
        ? `Facts:\n${source.facts.slice(0, 5).map((fact) => `- ${compact(fact).slice(0, 400)}`).join("\n")}`
        : null
    ].filter(Boolean);

    return lines.length ? `\n\nContext:\n${lines.join("\n")}` : "";
  }

  const lines = [
    source.sourceName ? `Source name: ${source.sourceName}` : null,
    source.sourceType ? `Source type: ${source.sourceType}` : null,
    source.title ? `Source title: ${source.title}` : null,
    source.url ? `Source URL: ${source.url}` : null,
    source.author ? `Author: ${source.author}` : null,
    source.publishedAt ? `Published: ${source.publishedAt}` : null,
    source.sourceType === "x-feed" ? null : source.summary ? `Source summary: ${source.summary}` : null,
    typeof source.engagement === "number" ? `Observed engagement score: ${source.engagement}` : null,
    source.topicTags?.length ? `Topic tags: ${source.topicTags.join(", ")}` : null,
    source.facts?.length
      ? `Grounded facts:\n${source.facts.map((fact, index) => `${source.sourceType === "x-feed" ? `${index + 1}.` : "-"} ${fact}`).join("\n")}`
      : null
  ].filter(Boolean);

  return lines.length ? `\n\nSource context:\n${lines.join("\n")}` : "";
}
