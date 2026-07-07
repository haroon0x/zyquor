import { describe, expect, it } from "vitest";
import {
  createGeminiGenerationProvider,
  createOllamaGenerationProvider,
  createOpenRouterGenerationProvider,
  GENERATION_MODEL_OPTIONS,
  isCleanTweetText,
  postProcessTweetText,
  resolveGenerationProviderConfig,
  scoreTweetQuality,
  buildSourceTweetInput,
  renderSourceContext,
  type FetchLike
} from "./index.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("ollama generation", () => {
  it("posts non-streaming JSON generation request", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        response: JSON.stringify({
          candidates: [{ text: "First local draft." }, { text: "Second local draft." }]
        })
      });
    };
    const provider = createOllamaGenerationProvider({
      baseUrl: "http://127.0.0.1:11434/",
      model: "llama3.1:8b",
      fetch: fetchImpl
    });

    const candidates = await provider.generateDraftCandidates({ idea: "Make it local.", count: 2, tweetType: "hiring" });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;

    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/generate");
    expect(body).toMatchObject({
      model: "llama3.1:8b",
      stream: false,
      format: "json"
    });
    expect(String(body.system)).toContain("Forbidden characters: — and –");
    expect(String(body.system)).toContain("not affiliated");
    expect(candidates).toEqual([
      { text: "First local draft.", score: { provider: "ollama", model: "llama3.1:8b", rank: 1, quality: 0 } },
      { text: "Second local draft.", score: { provider: "ollama", model: "llama3.1:8b", rank: 2, quality: 0 } }
    ]);
  });

  it("retries with line prompt when tiny model returns empty JSON candidates", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return jsonResponse({ response: '{"candidates":[],"status":"Draft"}' });
      }
      return jsonResponse({
        response: "Draft 1:\nKeep the automation path auditable before it touches a public account.\n\nDraft 2:\nLocal-first tools should make every browser action inspectable."
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
    expect(String(retryBody.prompt)).toContain("Forbidden characters: — and –");
    expect(candidates).toEqual([
      {
        text: "Keep the automation path auditable before it touches a public account.",
        score: { provider: "ollama", model: "qwen2.5:0.5b", rank: 1, quality: 1 }
      },
      {
        text: "Local-first tools should make every browser action inspectable.",
        score: { provider: "ollama", model: "qwen2.5:0.5b", rank: 2, quality: 1 }
      }
    ]);
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
              id: "moonshotai/kimi-k2.6:free",
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
      model: "moonshotai/kimi-k2.6:free",
      fetch: fetchImpl
    });

    const candidates = await provider.generateDraftCandidates({ idea: "Make it better.", count: 2 });
    const body = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    const headers = calls[1]?.init?.headers as Record<string, string>;

    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(calls[1]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer test-key");
    expect(body).toMatchObject({ model: "moonshotai/kimi-k2.6:free", response_format: { type: "json_object" } });
    expect(candidates).toEqual([
      { text: "Another clean OpenRouter draft.", score: { provider: "openrouter", model: "moonshotai/kimi-k2.6:free", rank: 1, quality: 0 } },
      { text: "A clean OpenRouter draft.", score: { provider: "openrouter", model: "moonshotai/kimi-k2.6:free", rank: 2, quality: -1 } }
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
              id: "moonshotai/kimi-k2.6:free",
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
      model: "moonshotai/kimi-k2.6:free",
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
        text: "Keep Zyquor ingest drafts human-reviewed before anything reaches X.",
        score: { provider: "openrouter", model: "moonshotai/kimi-k2.6:free", rank: 1, quality: 1 }
      },
      {
        text: "Make local posting automation auditable enough that every account action has a trail.",
        score: { provider: "openrouter", model: "moonshotai/kimi-k2.6:free", rank: 2, quality: 1 }
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
            id: "moonshotai/kimi-k2.6:free",
            pricing: { prompt: "0.000001", completion: "0", request: "0" }
          }
        ]
      });
    };
    const provider = createOpenRouterGenerationProvider({
      apiKey: "test-key",
      model: "moonshotai/kimi-k2.6:free",
      fetch: fetchImpl
    });

    await expect(provider.generateDraftCandidates({ idea: "Make it safe.", count: 1 })).rejects.toThrow(
      "OpenRouter model is not confirmed free: moonshotai/kimi-k2.6:free"
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
      { text: "A clean Gemini draft.", score: { provider: "gemini", model: "gemini-2.0-flash", rank: 1, quality: 0 } }
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
    expect(isCleanTweetText("Serverless billing punishes steady workloads: you pay for elasticity you never use.")).toBe(true);
  });

  it("scores specific candidates above vague ones", () => {
    const specific = "SQLite handles about 35% of production write loads fine if you batch transactions over 60 rows.";
    const vague = "Interesting how databases keep evolving!";
    expect(scoreTweetQuality(specific)).toBeGreaterThan(scoreTweetQuality(vague));
  });

  it("post-processes em dashes and drops duplicate candidates", async () => {
    expect(postProcessTweetText("AI infra — not model demos — is where the bottleneck moved.")).toBe(
      "AI infra, not model demos, is where the bottleneck moved."
    );
    expect(postProcessTweetText("why this matters:\n\n-  models ship faster  \n- users still need trust")).toBe(
      "why this matters:\n\n- models ship faster\n- users still need trust"
    );

    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        response: JSON.stringify({
          candidates: [
            { text: "AI infra — not model demos — is where the bottleneck moved." },
            { text: "AI infra, not model demos, is where the bottleneck moved." },
            { text: "Compute supply now decides which AI products can scale." }
          ]
        })
      });
    const provider = createOllamaGenerationProvider({ fetch: fetchImpl });

    await expect(provider.generateDraftCandidates({ idea: "AI infra bottleneck", count: 3 })).resolves.toEqual([
      {
        text: "AI infra, not model demos, is where the bottleneck moved.",
        score: { provider: "ollama", model: "llama3.1", rank: 1, quality: 1 }
      },
      {
        text: "Compute supply now decides which AI products can scale.",
        score: { provider: "ollama", model: "llama3.1", rank: 2, quality: 0 }
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
    expect(input.idea).toContain("Include the source URL only if it makes the post more useful or credible.");
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
        ZYQUOR_OPENROUTER_MODEL: "nvidia/nemotron-3-super-120b-a12b:free"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      configured: true
    });

    expect(resolveGenerationProviderConfig({ ZYQUOR_LLM_PROVIDER: "ollama", ZYQUOR_OLLAMA_MODEL: "qwen3:8b" })).toMatchObject({
      provider: "ollama",
      model: "qwen3:8b",
      configured: true
    });

    expect(resolveGenerationProviderConfig({})).toMatchObject({
      provider: "ollama",
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
    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "openrouter",
        ZYQUOR_OPENROUTER_API_KEY: "test-key",
        ZYQUOR_OPENROUTER_MODEL: "openai/gpt-4.1-mini"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "openrouter/owl-alpha",
      configured: true
    });

    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "openrouter",
        ZYQUOR_OPENROUTER_API_KEY: "test-key",
        ZYQUOR_OPENROUTER_MODEL: "moonshotai/kimi-k2.6:free"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6:free",
      configured: true
    });

    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "openrouter",
        ZYQUOR_OPENROUTER_API_KEY: "test-key",
        ZYQUOR_OPENROUTER_MODEL: "z-ai/glm-4.5-air:free"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "z-ai/glm-4.5-air:free",
      configured: true
    });

    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "openrouter",
        ZYQUOR_OPENROUTER_API_KEY: "test-key",
        ZYQUOR_OPENROUTER_MODEL: "qwen/qwen3-next-80b-a3b-instruct:free"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "qwen/qwen3-next-80b-a3b-instruct:free",
      configured: true
    });
  });

  it("exposes provider-specific model dropdown options", () => {
    expect(GENERATION_MODEL_OPTIONS.openrouter).toContain("moonshotai/kimi-k2.6:free");
    expect(GENERATION_MODEL_OPTIONS.openrouter).toContain("openrouter/owl-alpha");
    expect(GENERATION_MODEL_OPTIONS.gemini).toContain("gemini-2.0-flash");
    expect(GENERATION_MODEL_OPTIONS.ollama).toContain("llama3.1");
  });
});
