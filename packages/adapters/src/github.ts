import type { SourceAdapter, SourceItem } from "./types.js";

const GITHUB_SEARCH_REPOSITORIES = "https://api.github.com/search/repositories";

export interface GitHubTrendingAdapterOptions {
  maxItems?: number;
  minStars?: number;
  pushedAfter?: string;
  query?: string;
  topic?: string;
}

export function createGitHubTrendingAdapter(options: GitHubTrendingAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 10;

  return {
    name: "github-trending",
    sourceType: "feed",
    async fetch(configMetadata = {}): Promise<SourceItem[]> {
      const query = buildGitHubQuery({
        minStars: numberFromMetadata(configMetadata.minStars) ?? options.minStars ?? 100,
        ...(stringFromMetadata(configMetadata.pushedAfter) ?? options.pushedAfter
          ? { pushedAfter: (stringFromMetadata(configMetadata.pushedAfter) ?? options.pushedAfter)! }
          : {}),
        ...(stringFromMetadata(configMetadata.query) ?? options.query
          ? { query: (stringFromMetadata(configMetadata.query) ?? options.query)! }
          : {}),
        ...(stringFromMetadata(configMetadata.topic) ?? options.topic
          ? { topic: (stringFromMetadata(configMetadata.topic) ?? options.topic)! }
          : {})
      });
      const perPage = numberFromMetadata(configMetadata.maxItems) ?? maxItems;
      const url = new URL(GITHUB_SEARCH_REPOSITORIES);
      url.searchParams.set("q", query);
      url.searchParams.set("sort", "stars");
      url.searchParams.set("order", "desc");
      url.searchParams.set("per_page", String(Math.min(Math.max(perPage, 1), 30)));

      try {
        const response = await globalThis.fetch(url, {
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "Zyquor/1.0"
          }
        });
        if (!response.ok) return [];
        const body = (await response.json()) as { items?: GitHubRepository[] };
        return (body.items ?? []).slice(0, perPage).map(repositoryToSourceItem);
      } catch {
        return [];
      }
    }
  };
}

function buildGitHubQuery(input: {
  minStars: number;
  pushedAfter?: string;
  query?: string;
  topic?: string;
}) {
  const terms = [input.query?.trim() || (input.topic ? `topic:${input.topic}` : "topic:ai")];
  terms.push(`stars:>${input.minStars}`);
  if (input.pushedAfter) {
    terms.push(`pushed:>${input.pushedAfter}`);
  }
  return terms.join(" ");
}

function repositoryToSourceItem(repository: GitHubRepository): SourceItem {
  const topics = repository.topics?.length ? `Topics: ${repository.topics.slice(0, 8).join(", ")}` : "";
  const description = repository.description ?? "No description provided.";
  return {
    title: `${repository.full_name}: ${description}`,
    url: repository.html_url,
    content: [
      description,
      `Language: ${repository.language ?? "unknown"}`,
      `Stars: ${repository.stargazers_count}`,
      `Forks: ${repository.forks_count}`,
      `Updated: ${repository.updated_at}`,
      topics
    ]
      .filter(Boolean)
      .join("\n"),
    metadata: {
      forks: repository.forks_count,
      language: repository.language,
      published: repository.created_at,
      pushedAt: repository.pushed_at,
      source: "github",
      stars: repository.stargazers_count,
      topics: repository.topics ?? [],
      updatedAt: repository.updated_at
    }
  };
}

function stringFromMetadata(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFromMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface GitHubRepository {
  created_at: string;
  description: string | null;
  forks_count: number;
  full_name: string;
  html_url: string;
  language: string | null;
  pushed_at: string;
  stargazers_count: number;
  topics?: string[];
  updated_at: string;
}
