import { assertDedicatedProfileDir } from "@zyquor/accounts";
import { createMemoryRepository } from "@zyquor/storage";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

function setup() {
  const repository = createMemoryRepository({ now: () => "2026-04-24T17:00:00.000Z" });
  return { app: buildApp({ repository }), repository };
}

describe("account routes", () => {
  it("creates an account with safe defaults and a dedicated profile", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/accounts",
      payload: { handle: "example_user" }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      account: {
        displayName: "example_user",
        handle: "example_user",
        profileDir: "profiles/example_user",
        styleProfileId: "style_default",
        postingMode: "autopost",
        enabled: true,
        dailyPostLimit: 300
      }
    });
    expect(() => assertDedicatedProfileDir(response.json().account.profileDir)).not.toThrow();
    await app.close();
  });

  it.each([
    { handle: "@example" },
    { handle: "Example" },
    { handle: "example", profileDir: "profiles/other" }
  ])("returns 400 for invalid creation input", async (payload) => {
    const { app } = setup();
    const response = await app.inject({ method: "POST", url: "/accounts", payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Invalid request" });
    await app.close();
  });

  it("returns 409 for a duplicate handle", async () => {
    const { app } = setup();
    await app.inject({ method: "POST", url: "/accounts", payload: { handle: "duplicate" } });
    const response = await app.inject({ method: "POST", url: "/accounts", payload: { handle: "duplicate" } });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "Duplicate account handle: duplicate" });
    await app.close();
  });

  it("returns 404 for an unknown account", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "DELETE", url: "/accounts/account_missing" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns 409 when deleting the last remaining account", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "DELETE", url: "/accounts/account_personal" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "Cannot delete the last remaining account" });
    await app.close();
  });

  it("blocks active jobs and deletes an account after its jobs become terminal", async () => {
    const { app, repository } = setup();
    const createdResponse = await app.inject({
      method: "POST",
      url: "/accounts",
      payload: { handle: "deletable", displayName: "Deletable" }
    });
    const account = createdResponse.json().account;
    const draft = await repository.createDraft({
      accountId: account.id,
      sourceInput: "Deletion route",
      candidates: [{ text: "Deletion route protection", score: {} }]
    });
    const approved = await repository.approveDraft({
      draftId: draft.draft.id,
      editedText: "Deletion route protection"
    });

    const blocked = await app.inject({ method: "DELETE", url: `/accounts/${account.id}` });
    expect(blocked.statusCode).toBe(409);
    await repository.updateJobStatus(approved.job.id, "cancelled");
    const deleted = await app.inject({ method: "DELETE", url: `/accounts/${account.id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ account: { id: account.id } });
    await app.close();
  });
});
