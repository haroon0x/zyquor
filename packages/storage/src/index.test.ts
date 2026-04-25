import { describe, expect, it } from "vitest";
import { createMemoryRepository } from "./index.js";

const times = [
  "2026-04-24T17:00:00.000Z",
  "2026-04-24T17:01:00.000Z",
  "2026-04-24T17:02:00.000Z",
  "2026-04-24T17:03:00.000Z"
];

describe("repository workflow", () => {
  it("creates, approves, and advances a prepare-only job", async () => {
    let index = 0;
    const repository = createMemoryRepository({
      now: () => times[index++] ?? times.at(-1)!
    });

    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Ship narrow workflows first.",
      candidates: [
        { text: "Draft one", score: { rank: 1 } },
        { text: "Draft two", score: { rank: 2 } }
      ]
    });

    expect(created.draft.status).toBe("selected");
    expect(created.candidates[0]?.selected).toBe(true);

    const approved = await repository.approveDraft({
      draftId: created.draft.id,
      editedText: "Draft one, edited."
    });

    expect(approved.draft.status).toBe("approved");
    expect(approved.job.status).toBe("approved");

    const queued = await repository.updateJobStatus(approved.job.id, "queued");
    const running = await repository.updateJobStatus(queued.id, "running");
    const prepared = await repository.updateJobStatus(running.id, "prepared");

    expect(prepared.status).toBe("prepared");
  });

  it("rejects duplicate approved text for the same account", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });

    const first = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Same idea",
      candidates: [{ text: "Same post text", score: {} }]
    });
    await repository.approveDraft({ draftId: first.draft.id, editedText: "Same post text" });

    const second = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Same idea again",
      candidates: [{ text: "Same post text", score: {} }]
    });

    await expect(repository.approveDraft({ draftId: second.draft.id, editedText: "Same   post text" })).rejects.toThrow(
      "Duplicate post text"
    );
  });
});
