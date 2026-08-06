const GENERIC_TOPIC_WORDS = new Set([
  "about",
  "after",
  "agent",
  "agents",
  "built",
  "code",
  "data",
  "from",
  "github",
  "guide",
  "into",
  "model",
  "news",
  "open",
  "platform",
  "repo",
  "show",
  "source",
  "system",
  "that",
  "this",
  "tool",
  "using",
  "with"
]);

export function topicWords(value: string) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .map((word) => word.replace(/^-+|-+$/g, ""))
      .filter((word) => word.length >= 4 && !GENERIC_TOPIC_WORDS.has(word))
      .slice(0, 12)
  );
}

export function hasTopicOverlap(title: string, recentTitles: string[]) {
  const current = topicWords(title);
  if (current.size === 0) return false;
  return recentTitles.some((recent) => {
    const recentWords = topicWords(recent);
    let overlap = 0;
    for (const word of current) {
      if (recentWords.has(word)) overlap += 1;
    }
    return overlap >= 3;
  });
}
