import { createMemoryRepository } from "@zyquor/storage";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("api workflow", () => {
  it("generates, approves, and dry-run prepares a job", async () => {
    const app = buildApp({
      generationEnv: { ZYQUOR_LLM_PROVIDER: "mock" },
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      })
    });

    const draftResponse = await app.inject({
      method: "POST",
      url: "/drafts",
      payload: {
        accountId: "account_personal",
        idea: "Make local automation auditable."
      }
    });

    expect(draftResponse.statusCode).toBe(201);
    const draftBody = draftResponse.json();

    const accountResponse = await app.inject({
      method: "PATCH",
      url: "/accounts/account_personal",
      payload: {
        displayName: "Personal",
        profileDir: "profiles/personal-main",
        postingMode: "prepare_only",
        enabled: true
      }
    });

    expect(accountResponse.statusCode).toBe(200);
    expect(accountResponse.json()).toMatchObject({
      account: {
        displayName: "Personal"
      }
    });

    const approveResponse = await app.inject({
      method: "POST",
      url: `/drafts/${draftBody.draft.id}/approve`,
      payload: {
        editedText: draftBody.draft.editedText
      }
    });

    expect(approveResponse.statusCode).toBe(201);
    const approveBody = approveResponse.json();

    const prepareResponse = await app.inject({
      method: "POST",
      url: `/jobs/${approveBody.job.id}/prepare`
    });

    expect(prepareResponse.statusCode).toBe(200);
    expect(prepareResponse.json()).toMatchObject({
      dryRun: true,
      job: {
        status: "prepared"
      }
    });

    const postResponse = await app.inject({
      method: "POST",
      url: `/jobs/${approveBody.job.id}/post`
    });

    expect(postResponse.statusCode).toBe(403);

    await app.close();
  });

  it("reports configured generation provider", async () => {
    const app = buildApp({
      generationEnv: {
        ZYQUOR_LLM_PROVIDER: "ollama",
        ZYQUOR_OLLAMA_MODEL: "llama3.1:8b",
        ZYQUOR_OLLAMA_BASE_URL: "http://127.0.0.1:11434"
      },
      repository: createMemoryRepository({
        now: () => "2026-04-24T17:00:00.000Z"
      })
    });

    const healthResponse = await app.inject({ method: "GET", url: "/health" });
    expect(healthResponse.json()).toMatchObject({
      ok: true,
      generation: {
        provider: "ollama",
        model: "llama3.1:8b"
      }
    });

    const generationResponse = await app.inject({ method: "GET", url: "/generation" });
    expect(generationResponse.json()).toMatchObject({
      generation: {
        provider: "ollama",
        model: "llama3.1:8b",
        configured: true
      }
    });

    await app.close();
  });

  it("does not prepare jobs for draft-only accounts", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const app = buildApp({ repository, generationEnv: { ZYQUOR_LLM_PROVIDER: "mock" } });

    await repository.updateAccount("account_personal", { postingMode: "draft_only" });
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Draft only",
      candidates: [{ text: "Draft only text", score: {} }]
    });
    const approved = await repository.approveDraft({ draftId: created.draft.id, editedText: "Draft only text" });

    const prepareResponse = await app.inject({
      method: "POST",
      url: `/jobs/${approved.job.id}/prepare`
    });

    expect(prepareResponse.statusCode).toBe(409);
    await app.close();
  });
});
