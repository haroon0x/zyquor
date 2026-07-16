import { createMemoryRepository } from "@zyquor/storage";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("onboarding status", () => {
  it("requires onboarding for all-new data", async () => {
    const app = buildApp({ generationEnv: {}, repository: createMemoryRepository() });

    const response = await app.inject({ method: "GET", url: "/onboarding/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      accountsCount: 1,
      hasDrafts: false,
      hasJobs: false,
      needsOnboarding: true,
      generation: { configured: true, isDefault: true, provider: "ollama" },
      xSessionCheckedOk: false
    });
    await app.close();
  });

  it("does not require onboarding after a draft exists", async () => {
    const repository = createMemoryRepository();
    await repository.createDraft({ accountId: "account_personal", sourceInput: "First idea" });
    const app = buildApp({ generationEnv: {}, repository });

    const response = await app.inject({ method: "GET", url: "/onboarding/status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ hasDrafts: true, needsOnboarding: false });
    await app.close();
  });
});
