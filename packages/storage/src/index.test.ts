import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountRequestSchema, type ReplyTarget } from "@zyquor/core";
import { createSqliteRepository, detectSqliteSupport, hashPostText, normalizePostText } from "./index.js";

// The JSON-file memory repository was removed; repository behavior tests run
// against a throwaway in-process SQLite database instead.
async function createTestRepository() {
  return createSqliteRepository(":memory:");
}

const replyTo: ReplyTarget = {
  tweetId: "1891234567890123456",
  authorHandle: "example_user",
  url: "https://x.com/example_user/status/1891234567890123456"
};

describe("repository workflow", () => {
  it("creates, approves, and advances a prepare-only job", async () => {
    const repository = await createTestRepository();

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
    const repository = await createTestRepository();

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
    const repository = await createTestRepository();

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

  it("finds source packet drafts from metadata when no candidates were stored", async () => {
    const repository = await createTestRepository();
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
    const repository = await createTestRepository();
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
    const repository = await createTestRepository();
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
    const postedAt = Date.parse((await repository.listPostHistory())[0]!.postedAt);

    await expect(repository.purgePostHistoryOlderThan(new Date(postedAt - 1000).toISOString())).resolves.toBe(0);
    await expect(repository.listPostHistory()).resolves.toHaveLength(1);
    await expect(repository.purgePostHistoryOlderThan(new Date(postedAt + 1000).toISOString())).resolves.toBe(1);
    await expect(repository.listPostHistory()).resolves.toHaveLength(0);
  });

  it("stores scheduled approval metadata", async () => {
    const repository = await createTestRepository();
    const scheduledFor = new Date(Date.now() + 86_400_000).toISOString();

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

  it("roundtrips reply targets through sqlite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zyquor-storage-"));
    try {
      const repository = await createSqliteRepository(join(directory, "app.sqlite"));
      const created = await repository.createDraft({
        accountId: "account_personal",
        sourceInput: "Reply with context",
        candidates: [{ text: "A sqlite reply", score: {} }],
        replyTo
      });
      const approved = await repository.approveDraft({
        draftId: created.draft.id,
        editedText: "A sqlite reply"
      });

      await expect(repository.getDraft(created.draft.id)).resolves.toMatchObject({ draft: { replyTo } });
      await expect(repository.getJob(approved.job.id)).resolves.toMatchObject({ replyTo });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("roundtrips ingest runs through sqlite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zyquor-ingest-runs-"));
    try {
      const repository = await createSqliteRepository(join(directory, "app.sqlite"));
      const run = await repository.createIngestRun({ configId: "ingest_config", accountId: "account_personal" });
      await repository.updateIngestRun(run.id, { status: "succeeded", packetsCreated: 3 });

      await expect(repository.listIngestRuns("account_personal")).resolves.toEqual([
        expect.objectContaining({
          id: run.id,
          configId: "ingest_config",
          accountId: "account_personal",
          status: "succeeded",
          error: null,
          packetsCreated: 3
        })
      ]);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("adds reply target columns to an existing sqlite database idempotently", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zyquor-storage-migration-"));
    const filePath = join(directory, "app.sqlite");
    try {
      const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
      const database = new DatabaseSync(filePath);
      database.exec(`
        CREATE TABLE drafts (
          id TEXT PRIMARY KEY NOT NULL,
          account_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_input TEXT NOT NULL,
          generated_text TEXT,
          edited_text TEXT,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE post_jobs (
          id TEXT PRIMARY KEY NOT NULL,
          account_id TEXT NOT NULL,
          draft_id TEXT NOT NULL,
          status TEXT NOT NULL,
          mode TEXT NOT NULL,
          scheduled_for TEXT,
          approved_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      database.close();

      await expect(createSqliteRepository(filePath)).resolves.toBeDefined();
      await expect(createSqliteRepository(filePath)).resolves.toBeDefined();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("stores source packets for deterministic source ingestion", async () => {
    const repository = await createTestRepository();

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
    const repository = await createTestRepository();
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

describe("sqlite account repository", () => {
  it("creates and deletes accounts with unified limits and active-job protection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zyquor-accounts-"));
    try {
      const repository = await createSqliteRepository(join(directory, "app.sqlite"));

      await expect(repository.getAccount("account_personal")).resolves.toMatchObject({ dailyPostLimit: 300 });
      const input = createAccountRequestSchema.parse({ handle: "second_user", displayName: "Second user" });
      const account = await repository.createAccount(input);
      expect(account).toMatchObject({
        displayName: "Second user",
        handle: "second_user",
        profileDir: "profiles/second_user",
        styleProfileId: "style_default",
        postingMode: "autopost",
        enabled: true,
        dailyPostLimit: 300
      });
      expect(account.id).toMatch(/^account_/);
      await expect(repository.createAccount(input)).rejects.toThrow("Duplicate account handle");

      const draft = await repository.createDraft({
        accountId: account.id,
        sourceInput: "Account deletion protection",
        candidates: [{ text: "Keep active account jobs safe", score: {} }]
      });
      const approved = await repository.approveDraft({
        draftId: draft.draft.id,
        editedText: "Keep active account jobs safe"
      });
      await expect(repository.deleteAccount(account.id)).rejects.toThrow("Cannot delete account with non-terminal job");
      await repository.updateJobStatus(approved.job.id, "cancelled");
      await expect(repository.deleteAccount(account.id)).resolves.toMatchObject({ id: account.id });
      await expect(repository.getAccount(account.id)).resolves.toBeNull();
      await expect(repository.getDraft(draft.draft.id)).resolves.toBeNull();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("sqlite tweet measurement ledger", () => {
  it("upserts one row per tweet and preserves tweet metadata on re-measure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zyquor-measurements-"));
    try {
      const repository = await createSqliteRepository(join(directory, "app.sqlite"));

      const first = await repository.upsertTweetMeasurement({
        accountId: "account_personal",
        tweetId: "999000111",
        origin: "external",
        postedAt: "2026-04-24T10:00:00.000Z",
        text: "organic post",
        hasLink: false,
        sourceType: null,
        tweetType: null,
        views: 12,
        likes: 0,
        replies: 0,
        reposts: 0,
        bookmarks: 0
      });
      expect(first).toMatchObject({ tweetId: "999000111", origin: "external", views: 12 });

      const reMeasured = await repository.upsertTweetMeasurement({
        accountId: "account_personal",
        tweetId: "999000111",
        origin: "external",
        postedAt: "2026-04-24T10:00:00.000Z",
        text: "organic post",
        hasLink: false,
        sourceType: null,
        tweetType: null,
        views: 21,
        likes: 1,
        replies: 0,
        reposts: 0,
        bookmarks: 0
      });
      expect(reMeasured.id).toBe(first.id);
      expect(reMeasured.views).toBe(21);
      expect(reMeasured.likes).toBe(1);
      expect(reMeasured.text).toBe("organic post");

      const all = await repository.listTweetMeasurements("account_personal");
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ tweetId: "999000111", views: 21 });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("sqlite quality gate failures", () => {
  it("lists rejected drafts with candidates while excluding approved drafts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zyquor-quality-gate-"));
    try {
      const repository = await createSqliteRepository(join(directory, "app.sqlite"));
      const qualityGate = {
        bestQuality: 2,
        threshold: 3,
        slopPhrase: null,
        reason: "all_below_quality_floor",
        rejectedAt: "2026-07-17T09:01:00.000Z"
      };
      const rejected = await repository.createDraft({
        accountId: "account_personal",
        sourceInput: "Rejected idea",
        candidates: [
          { text: "Rejected candidate one", score: { quality: 2 } },
          { text: "Rejected candidate two", score: { quality: 1 } }
        ],
        metadata: { qualityGate }
      });
      const approved = await repository.createDraft({
        accountId: "account_personal",
        sourceInput: "Previously rejected idea",
        candidates: [{ text: "Approved after review", score: { quality: 2 } }],
        metadata: { qualityGate }
      });
      await repository.approveDraft({ draftId: approved.draft.id, editedText: "Approved after review" });
      await repository.createDraft({
        accountId: "account_personal",
        sourceInput: "Ordinary selected draft",
        candidates: [{ text: "Ordinary candidate", score: { quality: 5 } }]
      });

      const failures = await repository.listQualityGateFailedDrafts();
      expect(failures).toEqual([
        {
          draft: expect.objectContaining({ id: rejected.draft.id, metadata: { qualityGate }, status: "selected" }),
          candidates: expect.arrayContaining(rejected.candidates)
        }
      ]);
      expect(failures[0]?.candidates).toHaveLength(2);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("knowledge entries", () => {
  it("creates, updates, toggles, and deletes entries per account", async () => {
    const directory = mkdtempSync(join(tmpdir(), "zyquor-knowledge-"));
    try {
      const repository = await createSqliteRepository(join(directory, "app.sqlite"));

      const businessAccount = await repository.createAccount(
        createAccountRequestSchema.parse({ handle: "business", displayName: "Business" })
      );

      const entry = await repository.createKnowledgeEntry({
        accountId: businessAccount.id,
        kind: "feature",
        title: "Export to CSV",
        content: "Exports include all fields, run server-side, available on every plan.",
        sourceUrl: "https://example.com/docs/export"
      });

      expect(entry).toMatchObject({
        accountId: businessAccount.id,
        kind: "feature",
        enabled: true,
        sourceUrl: "https://example.com/docs/export"
      });

      await expect(
        repository.createKnowledgeEntry({
          accountId: "account_missing",
          kind: "persona",
          title: "No such account",
          content: "Should fail."
        })
      ).rejects.toThrow("Account not found");

      const updated = await repository.updateKnowledgeEntry(entry.id, {
        content: "Exports include all fields and run server-side.",
        enabled: false
      });
      expect(updated).toMatchObject({ enabled: false, content: "Exports include all fields and run server-side." });
      expect(updated.updatedAt >= updated.createdAt).toBe(true);

      const list = await repository.listKnowledgeEntries(businessAccount.id);
      expect(list).toHaveLength(1);
      await expect(repository.listKnowledgeEntries("account_personal")).resolves.toHaveLength(0);

      await expect(repository.deleteKnowledgeEntry(entry.id)).resolves.toMatchObject({ id: entry.id });
      await expect(repository.deleteKnowledgeEntry(entry.id)).rejects.toThrow("not found");
      await expect(repository.listKnowledgeEntries(businessAccount.id)).resolves.toHaveLength(0);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

describe("indexed post history helpers", () => {
  it("counts and matches posts via indexed lookups instead of full scans", async () => {
    const repository = await createTestRepository();

    expect(await repository.getPostJobStatusCounts()).toEqual({});
    expect(await repository.hasPostJobs()).toBe(false);
    expect(await repository.getLatestPostedJob()).toBeNull();
    expect(await repository.getLatestSourcePacket()).toBeNull();
    expect(await repository.countSourcePackets()).toBe(0);
    expect(await repository.countIngestConfigs({ enabled: true })).toBe(0);
    expect(await repository.countPendingDrafts()).toBe(0);

    const first = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "First",
      candidates: [{ text: "First post text", score: {} }]
    });
    const second = await repository.createDraft({
      accountId: "account_personal",
      sourceInput: "Second",
      candidates: [{ text: "Second post text", score: {} }]
    });
    const firstApproval = await repository.approveDraft({ draftId: first.draft.id, editedText: "First post text" });
    await repository.approveDraft({ draftId: second.draft.id, editedText: "Second post text" });

    const history = await repository.createPostHistory({
      accountId: "account_personal",
      draftId: first.draft.id,
      postedText: "First post text",
      postUrl: "https://x.com/personal/status/1",
      sourceUrl: "https://example.com/story",
      tweetType: "useful_info"
    });

    expect(await repository.getPostJobStatusCounts()).toEqual({ approved: 2 });
    expect(await repository.hasPostJobs()).toBe(true);
    expect(await repository.countPendingDrafts()).toBe(0);

    expect((await repository.listJobsByDraftId(first.draft.id))[0]?.id).toBe(firstApproval.job.id);
    expect(await repository.listJobsByDraftId(second.draft.id)).toHaveLength(1);
    expect((await repository.listJobsByDraftId("draft_missing"))).toHaveLength(0);

    expect(await repository.getPostHistory(history.id)).toMatchObject({
      id: history.id,
      accountId: "account_personal",
      tweetType: "useful_info"
    });
    expect(await repository.getPostHistory("history_missing")).toBeNull();

    expect(await repository.getLatestPostHistoryForAccount("account_personal")).toMatchObject({ id: history.id });
    expect(await repository.getLatestPostHistoryForAccount("account_nobody")).toBeNull();

    expect(await repository.countPostHistorySince("account_personal", new Date(Date.now() - 60_000).toISOString())).toBe(1);
    expect(await repository.countPostHistorySince("account_personal", "2999-01-01T00:00:00.000Z")).toBe(0);

    expect(await repository.countPostHistoryByDraftId(first.draft.id)).toBe(1);
    expect(await repository.countPostHistoryByDraftId(second.draft.id)).toBe(0);
    expect(await repository.countPostHistoryBySourcePacket("account_personal", "packet_missing")).toBe(0);

    const textHash = hashPostText("First post text");
    expect(await repository.hasPostHistoryTextHash("account_personal", textHash, normalizePostText("First post text"))).toBe(true);
    expect(await repository.hasPostHistoryTextHash("account_personal", "deliberately_wrong_hash", normalizePostText("unrelated text"))).toBe(false);

    expect(await repository.hasPostHistorySourceUrl("account_personal", "https://example.com/story")).toBe(true);
    expect(await repository.hasPostHistorySourceUrl("account_personal", "https://other.com/elsewhere")).toBe(false);
    expect(await repository.hasPostHistorySourceUrl("account_nobody", "https://example.com/story")).toBe(false);
  });
});

describe("detectSqliteSupport", () => {
  it("returns available on Node >= 22.5", async () => {
    const nodeVersion = process.versions.node;
    const [major, minor] = nodeVersion.split(".").map(Number);
    if (major! < 22 || (major === 22 && minor! < 5)) {
      const result = await detectSqliteSupport();
      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
      return;
    }
    const result = await detectSqliteSupport();
    if (!result.available) {
      console.error("detectSqliteSupport error:", result.error);
    }
    expect(result.available).toBe(true);
  });
});
