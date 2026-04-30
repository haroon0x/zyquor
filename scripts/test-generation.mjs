import { determineGenerationStyle, buildSystemPrompt, buildUserPrompt } from "../packages/generation/dist/viral-generation.js";

console.log("=== Testing Generation Style Detection ===\n");

// Test high-value
console.log("Lesson:", determineGenerationStyle({
  idea: "I spent 3 months building a distributed system and learned these 5 architecture lessons",
  tweetType: "lesson"
}));

// Test viral
console.log("News:", determineGenerationStyle({
  idea: "OpenAI just announced GPT-5 with breakthrough reasoning",
  tweetType: "news_context"
}));

// Test opinion
console.log("Opinion:", determineGenerationStyle({
  idea: "Everyone is wrong about microservices - monoliths are better",
  tweetType: "opinion"
}));

console.log("\n=== Sample Prompts ===\n");
console.log("VIRAL:", buildSystemPrompt({ style: { type: "viral" }, count: 3 }).slice(0, 300) + "...");
console.log("\nHIGH-VALUE:", buildSystemPrompt({ style: { type: "high_value" }, count: 3 }).slice(0, 300) + "...");
console.log("\nUSER:", buildUserPrompt({
  idea: "How I reduced API latency by 60%",
  tweetType: "guide",
  style: { type: "balanced" }
}).slice(0, 300) + "...");
