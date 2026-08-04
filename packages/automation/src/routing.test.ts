import { describe, expect, it } from "vitest";
import { routeTweetType } from "./routing.js";

const item = {
  title: "A concrete source item",
  url: "https://example.com/source",
  content: "A concrete fact about the source item."
};

describe("routeTweetType", () => {
  it("routes job adapters to hiring", () => {
    expect(routeTweetType({ item, sourceName: "hiring-hackernews", sourceType: "job" }, { opinion: 100 })).toBe("hiring");
  });

  it("routes hiring metadata from aggregated sources to hiring", () => {
    expect(
      routeTweetType(
        { item: { ...item, metadata: { source: "hackernews-jobs", type: "hiring" } }, sourceType: "news" },
        { opinion: 100 }
      )
    ).toBe("hiring");
  });

  it("routes RSS and feed adapters to article summaries", () => {
    expect(routeTweetType({ item, sourceName: "rss", sourceType: "feed" }, { useful_info: 100 })).toBe("article_summary");
  });

  it("routes feed items inside aggregated news to article summaries", () => {
    const aggregatedItem = { ...item, source: "company-rss", sourceType: "feed" };
    expect(
      routeTweetType(
        { item: aggregatedItem, sourceName: "aggregated-news", sourceType: "news" },
        { useful_info: 100 }
      )
    ).toBe("article_summary");
  });

  it("uses the configured mix for other sources", () => {
    expect(routeTweetType({ item, sourceName: "hackernews", sourceType: "news" }, { news_context: 100 })).toBe("news_context");
  });

  it("routes x-feed digests to feed observations", () => {
    expect(routeTweetType({ item, sourceType: "x-feed" }, { opinion: 100 })).toBe("feed_observation");
  });
});
