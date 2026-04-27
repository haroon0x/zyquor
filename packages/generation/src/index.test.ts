import { describe, expect, it } from "vitest";
import {
  createGeminiGenerationProvider,
  createOllamaGenerationProvider,
  generateMockDraftCandidates,
  resolveGenerationProviderConfig,
  type FetchLike
} from "./index.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("mock generation", () => {
  it("returns deterministic draft candidates", () => {
    const candidates = generateMockDraftCandidates({
      idea: "Local-first tools should expose their audit trail.",
      count: 2
    });

    expect(candidates).toEqual([
      {
        text: "Local-first tools should expose their audit trail.\n\nThe useful part is the audit trail: idea, draft, approval, schedule, and browser action all stay visible.",
        score: { provider: "mock", rank: 1 }
      },
      {
        text: "Local-first tools should expose their audit trail.\n\nGood automation removes repetitive work without hiding decisions. Keep inputs, rules, timing, and outcomes inspectable.",
        score: { provider: "mock", rank: 2 }
      }
    ]);
  });
});

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

describe("gemini generation", () => {
  it("posts generateContent request with API key header", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: "prompt echo that must be ignored",
                  thought: true
                },
                {
                  text: JSON.stringify({
                    candidates: [{ text: "First Gemini draft." }, { text: "Second Gemini draft." }]
                  })
                }
              ]
            }
          }
        ]
      });
    };
    const provider = createGeminiGenerationProvider({
      apiKey: "test-key",
      model: "gemini-test",
      fetch: fetchImpl
    });

    const candidates = await provider.generateDraftCandidates({ idea: "Make it reliable.", count: 2 });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    const headers = calls[0]?.init?.headers as Record<string, string>;

    expect(calls[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
    expect(headers["x-goog-api-key"]).toBe("test-key");
    expect(body).toHaveProperty("systemInstruction");
    expect(body).toHaveProperty("contents");
    expect(body).toHaveProperty("generationConfig");
    expect(candidates).toEqual([
      { text: "First Gemini draft.", score: { provider: "gemini", model: "gemini-test", rank: 1 } },
      { text: "Second Gemini draft.", score: { provider: "gemini", model: "gemini-test", rank: 2 } }
    ]);
  });
});

describe("generation config", () => {
  it("resolves provider config from environment", () => {
    expect(resolveGenerationProviderConfig({ ZYQUOR_LLM_PROVIDER: "ollama", ZYQUOR_OLLAMA_MODEL: "qwen3:8b" })).toMatchObject({
      provider: "ollama",
      model: "qwen3:8b",
      configured: true
    });

    expect(resolveGenerationProviderConfig({ ZYQUOR_LLM_PROVIDER: "gemini" })).toMatchObject({
      provider: "gemini",
      configured: false
    });
  });
});
