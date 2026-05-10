import type { SourceAdapter, SourceItem } from "./types.js";

const PRODUCT_HUNT_GRAPHQL_URL = "https://api.producthunt.com/v2/api/graphql";

export interface ProductHuntAdapterOptions {
  apiToken?: string;
  maxItems?: number;
}

export function createProductHuntAdapter(options: ProductHuntAdapterOptions = {}): SourceAdapter {
  const maxItems = options.maxItems ?? 10;

  return {
    name: "producthunt",
    sourceType: "feed",
    async fetch(configMetadata = {}): Promise<SourceItem[]> {
      const token = tokenFromMetadata(configMetadata.apiToken) ?? options.apiToken ?? process.env.ZYQUOR_PRODUCTHUNT_API_TOKEN;
      if (!token) return [];
      const count = numberFromMetadata(configMetadata.maxItems) ?? maxItems;

      try {
        const response = await globalThis.fetch(PRODUCT_HUNT_GRAPHQL_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "user-agent": "Zyquor/1.0"
          },
          body: JSON.stringify({
            query: `query LatestPosts($first: Int!) {
              posts(first: $first, order: NEWEST) {
                edges {
                  node {
                    id
                    name
                    tagline
                    description
                    url
                    website
                    votesCount
                    commentsCount
                    createdAt
                    topics { edges { node { name } } }
                  }
                }
              }
            }`,
            variables: { first: Math.min(Math.max(count, 1), 20) }
          })
        });
        if (!response.ok) return [];
        const body = (await response.json()) as ProductHuntResponse;
        return (body.data?.posts.edges ?? []).map(({ node }) => productHuntPostToSourceItem(node));
      } catch {
        return [];
      }
    }
  };
}

function productHuntPostToSourceItem(post: ProductHuntPost): SourceItem {
  const topics = post.topics.edges.map((edge) => edge.node.name);
  const description = post.description || post.tagline;
  return {
    title: `${post.name}: ${post.tagline}`,
    url: post.website || post.url,
    content: [
      description,
      `Votes: ${post.votesCount}`,
      `Comments: ${post.commentsCount}`,
      topics.length ? `Topics: ${topics.join(", ")}` : ""
    ]
      .filter(Boolean)
      .join("\n"),
    metadata: {
      comments: post.commentsCount,
      id: post.id,
      published: post.createdAt,
      source: "producthunt",
      topics,
      votes: post.votesCount
    }
  };
}

function tokenFromMetadata(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFromMetadata(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface ProductHuntResponse {
  data?: {
    posts: {
      edges: Array<{ node: ProductHuntPost }>;
    };
  };
}

interface ProductHuntPost {
  commentsCount: number;
  createdAt: string;
  description: string | null;
  id: string;
  name: string;
  tagline: string;
  topics: {
    edges: Array<{ node: { name: string } }>;
  };
  url: string;
  votesCount: number;
  website: string | null;
}
