import { describe, expect, it, vi } from "vitest";
import { TWEET_TYPES } from "@zyquor/core";
import {
  createGeminiGenerationProvider,
  createOllamaGenerationProvider,
  createOpenRouterGenerationProvider,
  evaluateTweetQuality,
  GENERATION_MODEL_OPTIONS,
  isCleanTweetText,
  postProcessTweetText,
  resolveGenerationProviderConfig,
  scoreTweetQuality,
  stripThinking,
  buildSourceTweetInput,
  renderSourceContext,
  type FetchLike
} from "./index.js";
import { tweetTypeInstruction } from "./prompts.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("stripThinking", () => {
  it("removes think tag blocks", () => {
    expect(stripThinking('<think>Compare several approaches first.</think>\n{"candidates":[]}')).toBe(
      '{"candidates":[]}'
    );
  });

  it("removes a leading Thinking section", () => {
    expect(
      stripThinking(
        "Thinking...\nI should identify the angle.\n\nThinking...\nI should make it concise.\n\nDraft 1:\nFirst clean draft."
      )
    ).toBe(
      "Draft 1:\nFirst clean draft."
    );
  });
});

describe("tweet quality evaluator", () => {
  it("posts a zero-temperature Ollama judge request and normalizes its result", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        message: {
          content: '<think>Check the criteria.</think>\n```json\n{"score":"12","verdict":"excellent","reasons":["Concrete number","Natural phrasing","Strong opening","extra"]}\n```'
        }
      });
    };

    await expect(evaluateTweetQuality(
      { text: "SQLite handled 8 million rows on one $20 node.", tweetType: "useful_info", idea: "SQLite scale" },
      { baseUrl: "http://localhost:11434/", model: "judge-model", fetchImpl }
    )).resolves.toEqual({
      score: 10,
      verdict: "strong",
      reasons: ["Concrete number", "Natural phrasing", "Strong opening"]
    });

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(calls[0]?.url).toBe("http://localhost:11434/api/chat");
    expect(body).toMatchObject({
      model: "judge-model",
      stream: false,
      format: "json",
      think: false,
      options: { temperature: 0 }
    });
    const messages = body.messages as Array<{ content: string; role: string }>;
    expect(messages[0]?.content).toContain("specificity, hook strength, natural voice, and absence of AI slop");
    expect(JSON.parse(messages[1]?.content ?? "{}")).toEqual({
      text: "SQLite handled 8 million rows on one $20 node.",
      tweetType: "useful_info",
      idea: "SQLite scale"
    });
  });

  it("rejects malformed judge output", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ message: { content: "null" } });
    await expect(evaluateTweetQuality({ text: "A tweet." }, { fetchImpl })).rejects.toThrow(
      "Ollama quality judge returned invalid JSON"
    );
  });
});

describe("tweet type prompt guidance", () => {
  it("includes a non-copying style exemplar for every tweet type", () => {
    for (const tweetType of TWEET_TYPES) {
      const instruction = tweetTypeInstruction(tweetType);
      expect(instruction).toContain("Style reference only; never copy facts/wording:");
      expect(instruction).not.toContain("#");
    }
  });
});

describe("ollama generation", () => {
  it("renders reply context without treating the URL as browsed content", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ message: { content: '{"candidates":[{"text":"Useful reply."}]}' } });
    };
    const provider = createOllamaGenerationProvider({ fetch: fetchImpl });

    await provider.generateDraftCandidates({
      idea: "The post says audit logs should be readable by users.",
      tweetType: "reply",
      replyContext: {
        authorHandle: "target_user",
        url: "https://x.com/target_user/status/1898765432109876543"
      }
    });

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    const messages = body.messages as Array<{ content: string; role: string }>;
    expect(messages[1]?.content).toContain(
      "You are drafting a reply to @target_user's post at https://x.com/target_user/status/1898765432109876543."
    );
    expect(messages[1]?.content).toContain("using the user's description of the target post");
    expect(messages[1]?.content).toContain("Do not claim to have opened or read the linked post.");
  });

  it("posts non-streaming JSON generation request", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        message: {
          content: JSON.stringify({
            candidates: [{ text: "First local draft." }, { text: "Second local draft." }]
          })
        }
      });
    };
    const provider = createOllamaGenerationProvider({
      baseUrl: "http://127.0.0.1:11434/",
      model: "llama3.1:8b",
      fetch: fetchImpl
    });

    const candidates = await provider.generateDraftCandidates({ idea: "Make it local.", count: 2, tweetType: "hiring" });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;

    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(body).toMatchObject({
      model: "llama3.1:8b",
      stream: false,
      format: "json",
      think: false
    });
    const messages = body.messages as Array<{ content: string; role: string }>;
    expect(messages[0]?.content).toContain("Never use em or en dashes (— or –)");
    expect(messages[0]?.content).toContain("not affiliated");
    expect(candidates).toEqual([
      { text: "first local draft.", score: { provider: "ollama", model: "llama3.1:8b", rank: 1, quality: -1 } },
      { text: "second local draft.", score: { provider: "ollama", model: "llama3.1:8b", rank: 2, quality: -1 } }
    ]);
  });

  it("retries with line prompt when tiny model returns empty JSON candidates", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return jsonResponse({ message: { content: '{"candidates":[],"status":"Draft"}' } });
      }
      return jsonResponse({
        message: {
          content: "Draft 1:\nKeep the automation path auditable before it touches a public account.\n\nDraft 2:\nLocal-first tools should make every browser action inspectable."
        }
      });
    };
    const provider = createOllamaGenerationProvider({
      model: "qwen2.5:0.5b",
      fetch: fetchImpl
    });

    const candidates = await provider.generateDraftCandidates({ idea: "Make local automation auditable.", count: 2 });

    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ format: "json" });
    const retryBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    expect(retryBody).not.toHaveProperty("format");
    expect(retryBody).toMatchObject({ think: false });
    const retryMessages = retryBody.messages as Array<{ content: string; role: string }>;
    expect(retryMessages[0]?.content).toContain("Never use em or en dashes (— or –)");
    expect(candidates).toEqual([
      {
        text: "keep the automation path auditable before it touches a public account.",
        score: { provider: "ollama", model: "qwen2.5:0.5b", rank: 1, quality: 0 }
      },
      {
        text: "local-first tools should make every browser action inspectable.",
        score: { provider: "ollama", model: "qwen2.5:0.5b", rank: 2, quality: 0 }
      }
    ]);
  });

  it("keeps a representative account prompt ordered and under 4000 characters", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ message: { content: '{"candidates":[{"text":"sqlite serves this workload from one small node."}]}' } });
    };
    const provider = createOllamaGenerationProvider({ fetch: fetchImpl });

    await provider.generateDraftCandidates({
      bannedPhrases: ["thought-provoking"],
      context: { facts: ["SQLite serves 8 million rows from one $20 node."] },
      count: 3,
      idea: "An article explains why SQLite was enough for 8 million rows on one $20 node. https://example.com/sqlite",
      objective: "help working developers choose simpler infrastructure",
      recentPostHistory: [
        "postgres is great, but most side projects need fewer moving parts.",
        "a $10 queue can be enough when the workload is predictable.",
        "three boring cron jobs beat one workflow nobody can debug."
      ],
      systemPromptExtra: "Prefer lessons grounded in hands-on experience.",
      tone: "practical, candid, concise",
      tweetType: "article_summary"
    });

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    const messages = body.messages as Array<{ content: string; role: string }>;
    const prompt = messages[0]?.content ?? "";
    const headings = ["Role", "Non-negotiable rules", "Voice", "Tweet type", "Calibration examples", "User style", "Output format"];

    expect(prompt.length).toBeLessThan(4000);
    expect(headings.map((heading) => prompt.indexOf(heading))).toEqual(
      [...headings].map((heading) => prompt.indexOf(heading)).sort((left, right) => left - right)
    );
    expect(prompt).toContain("Use the tweet-type style reference above.");
    expect(prompt).toContain("Account voice notes:\nPrefer lessons grounded in hands-on experience.");

    await provider.generateDraftCandidates({
      idea: "SQLite serves 8 million rows from one $20 node.",
      systemPromptExtra: "Voice examples:\n1. sqlite is boring right up until boring saves a weekend.",
      tweetType: "feed_observation"
    });

    const overrideBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    const overrideMessages = overrideBody.messages as Array<{ content: string; role: string }>;
    const overridePrompt = overrideMessages[0]?.content ?? "";
    expect(overridePrompt).toContain("Account voice notes (example tweets below override the generic calibration pairs):");
    expect(overridePrompt).not.toContain("Weak:");
  });
});

describe("openrouter generation", () => {
  it("confirms free pricing before posting chat completion request with bearer auth", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/models")) {
        return jsonResponse({
          data: [
            {
              id: "cohere/north-mini-code:free",
              pricing: { prompt: "0", completion: "0", request: "0" }
            }
          ]
        });
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                candidates: [{ text: "A clean OpenRouter draft." }, { text: "Another clean OpenRouter draft." }]
              })
            }
          }
        ]
      });
    };
    const provider = createOpenRouterGenerationProvider({
      apiKey: "test-key",
      model: "cohere/north-mini-code:free",
      fetch: fetchImpl
    });

    const candidates = await provider.generateDraftCandidates({ idea: "Make it better.", count: 2 });
    const body = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    const headers = calls[1]?.init?.headers as Record<string, string>;

    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(calls[1]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer test-key");
    expect(body).toMatchObject({ model: "cohere/north-mini-code:free", response_format: { type: "json_object" } });
    expect(candidates).toEqual([
      { text: "a clean openrouter draft.", score: { provider: "openrouter", model: "cohere/north-mini-code:free", rank: 1, quality: -1 } },
      { text: "another clean openrouter draft.", score: { provider: "openrouter", model: "cohere/north-mini-code:free", rank: 2, quality: -1 } }
    ]);
  });

  it("retries OpenRouter with a line prompt when JSON candidates are empty", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/models")) {
        return jsonResponse({
          data: [
            {
              id: "cohere/north-mini-code:free",
              pricing: { prompt: "0", completion: "0", request: "0" }
            }
          ]
        });
      }
      if (calls.length === 2) {
        return jsonResponse({
          choices: [
            {
              message: {
                content: '{"candidates":[]}'
              }
            }
          ]
        });
      }
      return jsonResponse({
        choices: [
          {
            message: {
              content:
                "Keep Zyquor ingest drafts human-reviewed before anything reaches X.\nMake local posting automation auditable enough that every account action has a trail."
            }
          }
        ]
      });
    };
    const provider = createOpenRouterGenerationProvider({
      apiKey: "test-key",
      model: "cohere/north-mini-code:free",
      fetch: fetchImpl
    });

    const candidates = await provider.generateDraftCandidates({ idea: "Make ingest reliable and auditable.", count: 2 });
    const firstBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    const retryBody = JSON.parse(String(calls[2]?.init?.body)) as Record<string, unknown>;

    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(calls[1]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(calls[2]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(firstBody).toMatchObject({ response_format: { type: "json_object" } });
    expect(retryBody).not.toHaveProperty("response_format");
    expect(retryBody).toMatchObject({ temperature: 0.5, max_tokens: 500 });
    expect(candidates).toEqual([
      {
        text: "keep zyquor ingest drafts human-reviewed before anything reaches x.",
        score: { provider: "openrouter", model: "cohere/north-mini-code:free", rank: 1, quality: 0 }
      },
      {
        text: "make local posting automation auditable enough that every account action has a trail.",
        score: { provider: "openrouter", model: "cohere/north-mini-code:free", rank: 2, quality: 0 }
      }
    ]);
  });

  it("does not send a chat request when OpenRouter cannot confirm free pricing", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        data: [
          {
            id: "cohere/north-mini-code:free",
            pricing: { prompt: "0.000001", completion: "0", request: "0" }
          }
        ]
      });
    };
    const provider = createOpenRouterGenerationProvider({
      apiKey: "test-key",
      model: "cohere/north-mini-code:free",
      fetch: fetchImpl
    });

    await expect(provider.generateDraftCandidates({ idea: "Make it safe.", count: 1 })).rejects.toThrow(
      "OpenRouter model is not confirmed free: cohere/north-mini-code:free"
    );
    expect(calls.map((call) => call.url)).toEqual(["https://openrouter.ai/api/v1/models"]);
  });
});

describe("gemini generation", () => {
  it("posts JSON generation request to Gemini with selected model", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    candidates: [{ text: "A clean Gemini draft." }]
                  })
                }
              ]
            }
          }
        ]
      });
    };
    const provider = createGeminiGenerationProvider({
      apiKey: "gemini-key",
      model: "gemini-2.0-flash",
      fetch: fetchImpl
    });

    const candidates = await provider.generateDraftCandidates({ idea: "Make it better.", count: 1 });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;

    expect(calls[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=gemini-key"
    );
    expect(body).toMatchObject({
      generationConfig: {
        responseMimeType: "application/json"
      }
    });
    expect(candidates).toEqual([
      { text: "a clean gemini draft.", score: { provider: "gemini", model: "gemini-2.0-flash", rank: 1, quality: -1 } }
    ]);
  });
});

describe("tweet quality harness", () => {
  it("rejects internal leakage and incomplete text", () => {
    expect(isCleanTweetText("Zed 1.0 is available. SourcePackets make it easier to review.")).toBe(false);
    expect(isCleanTweetText("Noctua released CAD models for its fans,")).toBe(false);
    expect(isCleanTweetText("This release is a game changer for developers.")).toBe(false);
    expect(isCleanTweetText("Noctua released official fan CAD models so builders can verify fit before buying.")).toBe(true);
  });

  it("rejects AI-slop formula patterns", () => {
    expect(isCleanTweetText("Hot take: serverless is overrated for steady workloads.")).toBe(false);
    expect(isCleanTweetText("Unpopular opinion that most startups ship too slowly.")).toBe(false);
    expect(isCleanTweetText("Most AI startups will fail this year. Let that sink in.")).toBe(false);
    expect(isCleanTweetText("It's not the model, it's the data pipeline that decides quality.")).toBe(false);
    expect(isCleanTweetText("Nobody talks about how expensive vector databases get at scale.")).toBe(false);
    expect(isCleanTweetText("OpenAI just shipped a 10M token context window. Wild.")).toBe(false);
    expect(isCleanTweetText("This robust solution helps teams navigate the complexities of scaling.")).toBe(false);
    expect(isCleanTweetText("One queue — three workers — endless possibilities.")).toBe(false);
    expect(isCleanTweetText("Serverless billing punishes steady workloads: you pay for elasticity you never use.")).toBe(true);
  });

  it("scores specific candidates above vague ones", () => {
    const specific = "SQLite handles about 35% of production write loads fine if you batch transactions over 60 rows.";
    const vague = "Interesting how databases keep evolving!";
    expect(scoreTweetQuality(specific)).toBeGreaterThan(scoreTweetQuality(vague));
  });

  it("post-processes em dashes and drops duplicate candidates", async () => {
    expect(postProcessTweetText("AI infra — not model demos — is where the bottleneck moved.")).toBe(
      "ai infra, not model demos, is where the bottleneck moved."
    );
    expect(postProcessTweetText("why this matters:\n\n-  models ship faster  \n- users still need trust")).toBe(
      "why this matters:\n\n- models ship faster\n- users still need trust"
    );
    expect(postProcessTweetText("Read HTTPS://Example.COM/CaseSensitivePath?Token=AbC now")).toBe(
      "read HTTPS://Example.COM/CaseSensitivePath?Token=AbC now"
    );

    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        message: {
          content: JSON.stringify({
            candidates: [
              { text: "AI infra — not model demos — is where the bottleneck moved." },
              { text: "AI infra, not model demos, is where the bottleneck moved." },
              { text: "Compute supply now decides which AI products can scale." }
            ]
          })
        }
      });
    const provider = createOllamaGenerationProvider({ fetch: fetchImpl });

    await expect(provider.generateDraftCandidates({ idea: "AI infra bottleneck", count: 3 })).resolves.toEqual([
      {
        text: "ai infra, not model demos, is where the bottleneck moved.",
        score: { provider: "ollama", model: "gemma4:e4b", rank: 1, quality: 1 }
      },
      {
        text: "compute supply now decides which ai products can scale.",
        score: { provider: "ollama", model: "gemma4:e4b", rank: 2, quality: -1 }
      }
    ]);
  });

  it("builds grounded source context for reusable generation", () => {
    const input = buildSourceTweetInput({
      facts: ["The worker uses Hacker News as a real source.", "The draft is generated before browser posting."],
      summary: "Automatic worker pipeline connects source ingestion, LLM generation, approval, and posting.",
      title: "Automatic posting worker ships",
      url: "https://news.ycombinator.com/item?id=1",
      sourceName: "hackernews",
      sourceType: "news",
      topicTags: ["ai", "devtools"]
    });

    expect(input.idea).toContain("Source title: Automatic posting worker ships");
    expect(input.idea).toContain("Required attribution: <source-title>Automatic posting worker ships</source-title>");
    expect(input.idea).toContain(
      "Required source link: <source-url>https://news.ycombinator.com/item?id=1</source-url>"
    );
    expect(input.idea).toContain("reference at least one concrete fact above");
    expect(renderSourceContext(input.source)).toContain("Source type: news");
    expect(renderSourceContext(input.source)).toContain("Topic tags: ai, devtools");
    expect(renderSourceContext(input.source)).toContain("Grounded facts:");
  });
});

describe("generation config", () => {
  it("resolves provider config from environment", () => {
    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_OPENROUTER_API_KEY: "test-key",
        ZYQUOR_OPENROUTER_MODEL: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
      configured: true
    });

    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "auto",
        ZYQUOR_GEMINI_API_KEY: "gemini-key"
      })
    ).toMatchObject({
      provider: "gemini",
      configured: true
    });

    expect(resolveGenerationProviderConfig({ ZYQUOR_LLM_PROVIDER: "ollama", ZYQUOR_OLLAMA_MODEL: "qwen3:8b" })).toMatchObject({
      provider: "ollama",
      model: "qwen3:8b",
      configured: true
    });

    expect(resolveGenerationProviderConfig({})).toMatchObject({
      provider: "ollama",
      model: "gemma4:e4b",
      baseUrl: "http://127.0.0.1:11434",
      configured: true
    });
  });

  it("rejects unsupported providers", () => {
    expect(() =>
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "unsupported"
      })
    ).toThrow("Unsupported LLM provider: unsupported");
  });

  it("forces OpenRouter onto the free model allowlist", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "openrouter",
        ZYQUOR_OPENROUTER_API_KEY: "test-key",
        ZYQUOR_OPENROUTER_MODEL: "openai/gpt-4.1-mini"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "google/gemma-4-26b-a4b-it:free",
      configured: true
    });
    expect(warn).toHaveBeenCalledWith(
      'generation: OpenRouter model "openai/gpt-4.1-mini" is not in the free allowlist; using "google/gemma-4-26b-a4b-it:free"'
    );

    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "openrouter",
        ZYQUOR_OPENROUTER_API_KEY: "test-key",
        ZYQUOR_OPENROUTER_MODEL: "cohere/north-mini-code:free"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "cohere/north-mini-code:free",
      configured: true
    });

    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "openrouter",
        ZYQUOR_OPENROUTER_API_KEY: "test-key",
        ZYQUOR_OPENROUTER_MODEL: "tencent/hy3:free"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "tencent/hy3:free",
      configured: true
    });

    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "openrouter",
        ZYQUOR_OPENROUTER_API_KEY: "test-key",
        ZYQUOR_OPENROUTER_MODEL: "poolside/laguna-xs-2.1:free"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "poolside/laguna-xs-2.1:free",
      configured: true
    });
    warn.mockRestore();
  });

  it("exposes provider-specific model dropdown options", () => {
    expect(GENERATION_MODEL_OPTIONS.openrouter).toEqual([
      "google/gemma-4-26b-a4b-it:free",
      "google/gemma-4-31b-it:free",
      "tencent/hy3:free",
      "poolside/laguna-xs-2.1:free",
      "cohere/north-mini-code:free",
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"
    ]);
    expect(GENERATION_MODEL_OPTIONS.gemini).toContain("gemini-2.0-flash");
    expect(GENERATION_MODEL_OPTIONS.ollama).toContain("gemma4:e4b");
  });
});
