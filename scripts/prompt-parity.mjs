import {
  linePrompt,
  revisionPrompt,
  systemPrompt,
  userPrompt
} from "../packages/generation/dist/prompts.js";

const cases = {
  plain_idea: {
    idea: "  local   inference changes the cost curve  ",
    count: 2
  },
  packet_useful_info: {
    idea: "Source title: ExampleCo ships faster inference",
    count: 3,
    context: {
      title: "ExampleCo ships faster inference",
      url: "https://example.com/blog/inference",
      summary: "ExampleCo cut inference latency by batching across requests.",
      facts: [
        "ExampleCo ships a faster inference runtime.",
        "Batching across requests cut p99 latency 40%.",
        "ExampleCo ships a faster inference runtime."
      ],
      sourceName: "company-rss",
      sourceType: "news",
      publishedAt: "2026-10-01T10:00:00.000Z",
      engagement: 42,
      topicTags: ["inference", "latency"]
    },
    tweetType: "useful_info"
  },
  reply_with_target: {
    idea: "Reply to the thread",
    count: 1,
    tweetType: "reply",
    replyContext: {
      authorHandle: "someone",
      authorName: "Some One",
      url: "https://x.com/someone/status/1",
      text: "Most teams tune the model before the queue.",
      otherReplies: ["Agreed, the queue dominates.", "This matches our load tests."]
    }
  },
  full_voice: {
    idea: "Ship smaller defaults",
    count: 4,
    tweetType: "opinion",
    examplePosts: ["One real post about caching.\nSecond line.", "Another example post."],
    systemPromptExtra: "Examples:\nWrite like a tired infra engineer.",
    tone: "dry, practical",
    objective: "Make operators question their default timeouts",
    recentPostHistory: [
      "A post about connection pools that went long enough to be truncated here",
      "Short one"
    ],
    systemFeedback: ["Never open with a question.", "Cut adverbs."],
    bannedPhrases: ["game changer", "  ", "unlock"]
  },
  knowledge_and_memory: {
    idea: "Why we moved off the queue",
    count: 2,
    memoryContext: "I ran a 3-node cluster in 2021 and lost a week to fsync.",
    feedback: "Too long last time; keep it under 240.",
    accountKnowledge: [
      { kind: "project", title: "Queue", content: "We replaced RabbitMQ with NATS in 2024." },
      { kind: "role", title: "Owner", content: "Runs the ingestion pipeline." }
    ]
  },
  x_feed: {
    idea: "Recent posts from the X home feed.",
    count: 2,
    tweetType: "feed_observation",
    context: {
      title: "Feed",
      url: null,
      summary: "",
      facts: ["post about quantization", "post about local runners", "post about quantization"],
      sourceType: "x-feed"
    }
  },
  job_packet: {
    idea: "Hiring post",
    count: 1,
    context: {
      title: "ExampleCo is hiring infra engineers",
      url: "https://example.com/jobs",
      summary: "Remote infra role.",
      facts: ["Remote", "Go and Rust"],
      sourceType: "job"
    }
  },
  single_count: {
    idea: "One thought only",
    tweetType: "guide",
    count: 1
  }
};

const out = {};
for (const [name, input] of Object.entries(cases)) {
  out[name] = {
    system: systemPrompt(input),
    user: userPrompt(input),
    line: linePrompt(input),
    revision: revisionPrompt(input, ["first draft text", "second draft text"])
  };
}
console.log(JSON.stringify(out, null, 1));
