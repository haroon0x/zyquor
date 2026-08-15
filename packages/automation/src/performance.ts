import { postPerformanceFromMetadata } from "@zyquor/core";
import type { ZyquorRepository } from "@zyquor/storage";

export interface SourcePerformance {
  sourceType: string;
  posts: number;
  engagementPerPost: number;
  viewsAvg: number;
}

const REPLY_WEIGHT = 10;
const REPOST_WEIGHT = 2;

export function engagementPerPostOf(performance: {
  likes?: number | null;
  replies?: number | null;
  reposts?: number | null;
  posts: number;
}): number {
  if (!performance.posts || performance.posts <= 0) return 0;
  const units =
    (performance.likes ?? 0) +
    REPLY_WEIGHT * (performance.replies ?? 0) +
    REPOST_WEIGHT * (performance.reposts ?? 0);
  return units / performance.posts;
}

export async function sourcePerformanceByType(repository: ZyquorRepository): Promise<Map<string, SourcePerformance>> {
  const history = await repository.listPostHistory();
  const totals = new Map<
    string,
    { posts: number; likes: number; replies: number; reposts: number; views: number }
  >();
  for (const item of history) {
    if (!item.sourceType) continue;
    const performance = postPerformanceFromMetadata(item.metadata);
    if (!performance) continue;
    const current = totals.get(item.sourceType) ?? { posts: 0, likes: 0, replies: 0, reposts: 0, views: 0 };
    current.posts += 1;
    current.likes += performance.likes ?? 0;
    current.replies += performance.replies ?? 0;
    current.reposts += performance.reposts ?? 0;
    current.views += performance.views ?? 0;
    totals.set(item.sourceType, current);
  }
  const result = new Map<string, SourcePerformance>();
  for (const [sourceType, total] of totals) {
    result.set(sourceType, {
      sourceType,
      posts: total.posts,
      engagementPerPost: engagementPerPostOf(total),
      viewsAvg: total.posts > 0 ? total.views / total.posts : 0
    });
  }
  return result;
}
