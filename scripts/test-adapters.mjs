import { createHackerNewsAdapter } from "../packages/adapters/dist/hackernews.js";
import { createRedditAdapter } from "../packages/adapters/dist/reddit.js";
import { createArxivAdapter } from "../packages/adapters/dist/arxiv.js";
import { createTechCrunchAdapter } from "../packages/adapters/dist/techcrunch.js";

async function testAdapters() {
  console.log("=== Testing Source Adapters ===\n");

  console.log("Fetching Hacker News...");
  const hn = createHackerNewsAdapter({ maxItems: 3 });
  const hnItems = await hn.fetch();
  console.log(`HN: ${hnItems.length} items`);

  console.log("\nFetching Reddit...");
  const reddit = createRedditAdapter({ subreddit: "programming", maxItems: 3 });
  const redditItems = await reddit.fetch();
  console.log(`Reddit: ${redditItems.length} items`);

  console.log("\nFetching arXiv...");
  const arxiv = createArxivAdapter({ categories: ["cs.AI"], maxItems: 3 });
  const arxivItems = await arxiv.fetch();
  console.log(`arXiv: ${arxivItems.length} items`);

  console.log("\nFetching TechCrunch...");
  const tc = createTechCrunchAdapter({ sections: ["ai"], maxItems: 3 });
  const tcItems = await tc.fetch();
  console.log(`TechCrunch: ${tcItems.length} items`);

  console.log("\n=== DONE ===");
}

testAdapters().catch(console.error);
