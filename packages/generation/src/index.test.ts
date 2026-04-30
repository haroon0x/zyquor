import { describe, expect, it } from "vitest";
import {
  createOllamaGenerationProvider,
  createOpenRouterGenerationProvider,
  isCleanTweetText,
  resolveGenerationProviderConfig,
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

    const candidates = await provider.generateDraftCandidates({ idea: "Make it local.", count: 2 });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;

    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/generate");
    expect(body).toMatchObject({
      model: "llama3.1:8b",
      stream: false,
      format: "json"
    });
    expect(candidates).toEqual([
      { text: "First local draft.", score: { provider: "ollama", model: "llama3.1:8b", rank: 1 } },
      { text: "Second local draft.", score: { provider: "ollama", model: "llama3.1:8b", rank: 2 } }
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
    expect(JSON.parse(String(calls[1]?.init?.body))).not.toHaveProperty("format");
    expect(candidates).toEqual([
      {
        text: "Keep the automation path auditable before it touches a public account.",
        score: { provider: "ollama", model: "qwen2.5:0.5b", rank: 1 }
      },
      {
        text: "Local-first tools should make every browser action inspectable.",
        score: { provider: "ollama", model: "qwen2.5:0.5b", rank: 2 }
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
              id: "minimax/minimax-m2.5:free",
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
      model: "minimax/minimax-m2.5:free",
      fetch: fetchImpl
    });

    const candidates = await provider.generateDraftCandidates({ idea: "Make it better.", count: 2 });
    const body = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    const headers = calls[1]?.init?.headers as Record<string, string>;

    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/models");
    expect(calls[1]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(headers.authorization).toBe("Bearer test-key");
    expect(body).toMatchObject({ model: "minimax/minimax-m2.5:free", response_format: { type: "json_object" } });
    expect(candidates).toEqual([
      { text: "A clean OpenRouter draft.", score: { provider: "openrouter", model: "minimax/minimax-m2.5:free", rank: 1 } },
      { text: "Another clean OpenRouter draft.", score: { provider: "openrouter", model: "minimax/minimax-m2.5:free", rank: 2 } }
    ]);
  });

  it("does not send a chat request when OpenRouter cannot confirm free pricing", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        data: [
          {
            id: "minimax/minimax-m2.5:free",
            pricing: { prompt: "0.000001", completion: "0", request: "0" }
          }
        ]
      });
    };
    const provider = createOpenRouterGenerationProvider({
      apiKey: "test-key",
      model: "minimax/minimax-m2.5:free",
      fetch: fetchImpl
    });

    await expect(provider.generateDraftCandidates({ idea: "Make it safe.", count: 1 })).rejects.toThrow(
      "OpenRouter model is not confirmed free: minimax/minimax-m2.5:free"
    );
    expect(calls.map((call) => call.url)).toEqual(["https://openrouter.ai/api/v1/models"]);
  });
});

describe("tweet quality harness", () => {
  it("rejects internal leakage and incomplete text", () => {
    expect(isCleanTweetText("Zed 1.0 is available. SourcePackets make it easier to review.")).toBe(false);
    expect(isCleanTweetText("Noctua released CAD models for its fans,")).toBe(false);
    expect(isCleanTweetText("Noctua released official fan CAD models so builders can verify fit before buying.")).toBe(true);
  });

  it("builds grounded source context for reusable generation", () => {
    const input = buildSourceTweetInput({
      facts: ["The worker uses Hacker News as a real source.", "The draft is generated before browser posting."],
      summary: "Automatic worker pipeline connects source ingestion, LLM generation, approval, and posting.",
      title: "Automatic posting worker ships",
      url: "https://news.ycombinator.com/item?id=1",
      sourceName: "hackernews",
      topicTags: ["ai", "devtools"]
    });

    expect(input.idea).toContain("News headline: Automatic posting worker ships");
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
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      configured: true
    });

    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "openrouter",
        ZYQUOR_OPENROUTER_API_KEY: "test-key",
        ZYQUOR_OPENROUTER_MODEL: "minimax/minimax-m2.5:free"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "minimax/minimax-m2.5:free",
      configured: true
    });

    expect(
      resolveGenerationProviderConfig({
        ZYQUOR_LLM_PROVIDER: "openrouter",
        ZYQUOR_OPENROUTER_API_KEY: "test-key",
        ZYQUOR_OPENROUTER_MODEL: "tencent/hy3-preview:free"
      })
    ).toMatchObject({
      provider: "openrouter",
      model: "tencent/hy3-preview:free",
      configured: true
    });
  });
});
