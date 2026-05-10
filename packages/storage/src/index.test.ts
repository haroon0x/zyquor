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

  it("claims only one browser job per account", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });

    const firstDraft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "First claim",
      candidates: [{ text: "First claim text", score: {} }]
    });
    const secondDraft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Second claim",
      candidates: [{ text: "Second claim text", score: {} }]
    });
    const first = await repository.approveDraft({ draftId: firstDraft.draft.id, editedText: "First claim text" });
    const second = await repository.approveDraft({ draftId: secondDraft.draft.id, editedText: "Second claim text" });

    await expect(repository.claimJobForBrowserRun(first.job.id, ["approved"])).resolves.toMatchObject({
      id: first.job.id,
      status: "queued"
    });
    await expect(repository.claimJobForBrowserRun(second.job.id, ["approved"])).resolves.toBeNull();
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

  it("rejects post text over the X free-tier character limit", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });

    await expect(
      repository.createDraft({
        accountId: "account_personal",
        sourceInput: "Too long",
        candidates: [{ text: "x".repeat(281), score: {} }]
      })
    ).rejects.toThrow("Post text exceeds 280 characters");

    const draft = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Too long approval",
      candidates: [{ text: "Short enough", score: {} }]
    });
    await expect(repository.approveDraft({ draftId: draft.draft.id, editedText: "x".repeat(281) })).rejects.toThrow(
      "Post text exceeds 280 characters"
    );
  });

  it("finds source packet drafts from metadata when no candidates were stored", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const packet = await repository.createSourcePacket({
      accountId: "account_personal",
      facts: ["Uses a source metadata link"],
      sourceType: "news",
      summary: "Source summary",
      title: "Source title",
      tweetType: "news_context",
      url: "https://example.com/source"
    });
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Source idea",
      metadata: { sourcePacketId: packet.id }
    });

    await expect(repository.getDraftBySourcePacketId(packet.id)).resolves.toMatchObject({
      draft: { id: created.draft.id },
      candidates: []
    });
  });

  it("does not delete drafts referenced by post history", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Posted draft",
      candidates: [{ text: "Posted draft text", score: {} }]
    });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: created.draft.id,
      postedText: "Posted draft text",
      postUrl: "https://x.com/personal/status/history"
    });

    await expect(repository.deleteDraft(created.draft.id)).rejects.toThrow("Cannot delete draft with post history");
    await expect(repository.getDraft(created.draft.id)).resolves.toMatchObject({ draft: { id: created.draft.id } });
  });

  it("purges post history older than a cutoff", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Posted draft",
      candidates: [{ text: "Recent posted text", score: {} }]
    });
    await repository.createPostHistory({
      accountId: "account_personal",
      draftId: created.draft.id,
      postedText: "Recent posted text",
      postUrl: "https://x.com/personal/status/recent"
    });

    await expect(repository.purgePostHistoryOlderThan("2026-04-24T16:59:59.000Z")).resolves.toBe(0);
    await expect(repository.listPostHistory()).resolves.toHaveLength(1);
    await expect(repository.purgePostHistoryOlderThan("2026-04-24T17:00:01.000Z")).resolves.toBe(1);
    await expect(repository.listPostHistory()).resolves.toHaveLength(0);
  });

  it("stores scheduled approval metadata", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const scheduledFor = "2026-04-25T15:30:00.000Z";

    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Schedule this",
      candidates: [{ text: "Scheduled useful post", score: {} }]
    });
    const approved = await repository.approveDraft({
      draftId: created.draft.id,
      editedText: "Scheduled useful post",
      mode: "scheduled",
      scheduledFor
    });

    expect(approved.job).toMatchObject({
      mode: "scheduled",
      scheduledFor,
      status: "approved"
    });
  });

  it("stores source packets for deterministic source ingestion", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });

    const packet = await repository.createSourcePacket({
      accountId: "account_personal",
      facts: ["Frontier models are becoming infrastructure.", "Capital is concentrating around compute."],
      sourceType: "news",
      summary: "AI funding is shifting from model demos to infrastructure scale.",
      title: "AI infrastructure funding",
      tweetType: "news_context",
      url: "https://example.com/ai"
    });

    expect(packet).toMatchObject({
      accountId: "account_personal",
      sourceType: "news",
      status: "new",
      tweetType: "news_context",
      url: "https://example.com/ai"
    });
    await expect(repository.getSourcePacket(packet.id)).resolves.toMatchObject({ title: "AI infrastructure funding" });
    await expect(repository.listSourcePackets("account_personal")).resolves.toHaveLength(1);
    await expect(repository.markSourcePacketDrafted(packet.id)).resolves.toMatchObject({ status: "drafted" });
    await expect(repository.deleteSourcePacket(packet.id)).resolves.toMatchObject({ id: packet.id });
    await expect(repository.listSourcePackets("account_personal")).resolves.toHaveLength(0);
  });

  it("deletes source-generated drafts and resets source packet status", async () => {
    const repository = createMemoryRepository({
      now: () => "2026-04-24T17:00:00.000Z"
    });
    const packet = await repository.createSourcePacket({
      accountId: "account_personal",
      facts: ["Science funding is moving toward applied energy work."],
      sourceType: "news",
      summary: "Battery research could affect energy markets.",
      title: "Battery research funding",
      tweetType: "news_context",
      url: "https://example.com/battery"
    });
    const created = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Battery research funding",
      candidates: [
        {
          text: "Battery research is becoming an energy markets story.",
          score: { sourcePacketId: packet.id }
        }
      ]
    });
    await repository.markSourcePacketDrafted(packet.id);
    await repository.approveDraft({
      draftId: created.draft.id,
      editedText: "Battery research is becoming an energy markets story."
    });

    await expect(repository.getDraftBySourcePacketId(packet.id)).resolves.toMatchObject({
      draft: { id: created.draft.id }
    });
    await expect(repository.deleteDraft(created.draft.id)).resolves.toMatchObject({
      draft: { id: created.draft.id }
    });
    await expect(repository.resetSourcePacket(packet.id)).resolves.toMatchObject({ status: "new" });
    await expect(repository.getDraft(created.draft.id)).resolves.toBeNull();
    await expect(repository.listJobs()).resolves.toHaveLength(0);
  });
});
