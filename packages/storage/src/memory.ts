import type {
  Account,
  Draft,
  DraftCandidate,
  PostAttempt,
  PostHistory,
  PostJob,
  SourcePacket,
  StyleProfile,
  IngestConfig
} from "@zyquor/core";
import { X_FREE_POST_CHARACTER_LIMIT, canTransitionDraft, canTransitionPostJob, nextAutopostScheduledFor, dataPath, parseReplyTargetUrl } from "@zyquor/core";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ZyquorRepository, RepositorySnapshot, ContentFingerprint, IngestRun } from "./types.js";
import { id as idGen, normalizePostText, hashPostText } from "./utils.js";

export function defaultJsonDatabasePath(): string {
  return dataPath("data", "app.json");
}

export interface MemoryRepositoryOptions {
  now?: () => string;
  snapshot?: Partial<RepositorySnapshot>;
  onChange?: (snapshot: RepositorySnapshot) => void;
}

function assertTweetTextFitsLimit(text: string) {
  if (text.length > X_FREE_POST_CHARACTER_LIMIT) {
    throw new Error(`Post text exceeds ${X_FREE_POST_CHARACTER_LIMIT} characters`);
  }
}

export function createMemoryRepository(options: MemoryRepositoryOptions = {}): ZyquorRepository {
  const now = options.now ?? (() => new Date().toISOString());
  const styleProfile: StyleProfile = {
    id: "style_default",
    name: "Default",
    description: "Default concise posting style.",
    tone: "clear, concrete, low-filler",
    rules: {},
    bannedPhrases: ["game changer", "unlock", "10x"],
    examplePosts: [],
    createdAt: now(),
    updatedAt: now()
  };

  const defaultAccounts: Account[] = [
    {
      id: "account_personal",
      handle: "personal-main",
      displayName: "Personal main",
      profileDir: "profiles/personal-main",
      styleProfileId: styleProfile.id,
      postingMode: "prepare_only",
      enabled: true,
      dailyPostLimit: 300,
      quietHoursStart: null,
      quietHoursEnd: null,
      createdAt: now(),
      updatedAt: now()
    }
  ];

  const accounts = new Map<string, Account>((options.snapshot?.accounts ?? defaultAccounts).map((account) => [account.id, account]));
  const styleProfiles = new Map<string, StyleProfile>(
    (options.snapshot?.styleProfiles ?? [styleProfile]).map((profile) => [profile.id, profile])
  );
  const drafts = new Map<string, Draft>((options.snapshot?.drafts ?? []).map((draft) => [draft.id, draft]));
  const candidates = new Map<string, DraftCandidate>(
    (options.snapshot?.candidates ?? []).map((candidate) => [candidate.id, candidate])
  );
  const jobs = new Map<string, PostJob>((options.snapshot?.jobs ?? []).map((job) => [job.id, job]));
  const attempts = new Map<string, PostAttempt>((options.snapshot?.attempts ?? []).map((attempt) => [attempt.id, attempt]));
  const ingestRuns = new Map<string, IngestRun>((options.snapshot?.ingestRuns ?? []).map((run) => [run.id, run]));
  const history = new Map<string, PostHistory>((options.snapshot?.history ?? []).map((item) => [item.id, item]));
  const fingerprints = new Map<string, ContentFingerprint>(
    (options.snapshot?.fingerprints ?? []).map((item) => [item.id, item])
  );
  const sourcePackets = new Map<string, SourcePacket>(
    (options.snapshot?.sourcePackets ?? []).map((packet) => [packet.id, packet])
  );
  const ingestConfigs = new Map<string, IngestConfig>(
    (options.snapshot?.ingestConfigs ?? []).map((config) => [config.id, config])
  );
  let sequence = options.snapshot?.sequence ?? 0;

  function snapshot(): RepositorySnapshot {
    return {
      accounts: [...accounts.values()],
      drafts: [...drafts.values()],
      candidates: [...candidates.values()],
      jobs: [...jobs.values()],
      attempts: [...attempts.values()],
      ingestRuns: [...ingestRuns.values()],
      history: [...history.values()],
      fingerprints: [...fingerprints.values()],
      ingestConfigs: [...ingestConfigs.values()],
      sourcePackets: [...sourcePackets.values()],
      styleProfiles: [...styleProfiles.values()],
      sequence
    };
  }

  function persist() {
    options.onChange?.(snapshot());
  }

  function id(prefix: string) {
    sequence += 1;
    return `${prefix}_${sequence.toString().padStart(6, "0")}`;
  }

  function candidatesForDraft(draftId: string) {
    return [...candidates.values()].filter((candidate) => candidate.draftId === draftId);
  }

  function requireDraft(id: string) {
    const draft = drafts.get(id);
    if (!draft) {
      throw new Error(`Draft not found: ${id}`);
    }
    return draft;
  }

  function requireJob(id: string) {
    const job = jobs.get(id);
    if (!job) {
      throw new Error(`Job not found: ${id}`);
    }
    return job;
  }

  return {
    async listAccounts() {
      return [...accounts.values()];
    },

    async createAccount(input) {
      if ([...accounts.values()].some((account) => account.handle === input.handle)) {
        throw new Error(`Duplicate account handle: ${input.handle}`);
      }

      const timestamp = now();
      const account: Account = {
        id: id("account"),
        handle: input.handle,
        displayName: input.displayName,
        profileDir: input.profileDir,
        styleProfileId: "style_default",
        postingMode: "prepare_only",
        enabled: true,
        dailyPostLimit: 300,
        quietHoursStart: null,
        quietHoursEnd: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      accounts.set(account.id, account);
      persist();
      return account;
    },

    async getAccount(id) {
      return accounts.get(id) ?? null;
    },

    async deleteAccount(id) {
      const account = accounts.get(id);
      if (!account) {
        throw new Error(`Account not found: ${id}`);
      }
      const blockedJob = [...jobs.values()].find(
        (job) => job.accountId === id && job.status !== "posted" && job.status !== "cancelled"
      );
      if (blockedJob) {
        throw new Error(`Cannot delete account with non-terminal job: ${blockedJob.id}`);
      }

      const accountDraftIds = new Set([...drafts.values()].filter((draft) => draft.accountId === id).map((draft) => draft.id));
      const accountJobIds = new Set([...jobs.values()].filter((job) => job.accountId === id).map((job) => job.id));
      for (const [attemptId, attempt] of attempts) {
        if (accountJobIds.has(attempt.jobId)) attempts.delete(attemptId);
      }
      for (const [candidateId, candidate] of candidates) {
        if (accountDraftIds.has(candidate.draftId)) candidates.delete(candidateId);
      }
      for (const [jobId, job] of jobs) {
        if (job.accountId === id) jobs.delete(jobId);
      }
      for (const [fingerprintId, fingerprint] of fingerprints) {
        if (fingerprint.accountId === id) fingerprints.delete(fingerprintId);
      }
      for (const [historyId, item] of history) {
        if (item.accountId === id) history.delete(historyId);
      }
      for (const [packetId, packet] of sourcePackets) {
        if (packet.accountId === id) sourcePackets.delete(packetId);
      }
      for (const [runId, run] of ingestRuns) {
        if (run.accountId === id) ingestRuns.delete(runId);
      }
      for (const [configId, config] of ingestConfigs) {
        if (config.accountId === id) ingestConfigs.delete(configId);
      }
      for (const draftId of accountDraftIds) drafts.delete(draftId);
      accounts.delete(id);
      persist();
      return account;
    },

    async updateAccount(id, input) {
      const account = accounts.get(id);
      if (!account) {
        throw new Error(`Account not found: ${id}`);
      }

      const updated: Account = {
        ...account,
        ...input,
        updatedAt: now()
      };
      accounts.set(id, updated);
      persist();
      return updated;
    },

    async getStyleProfile(id) {
      return styleProfiles.get(id) ?? null;
    },

    async updateStyleProfile(id, input) {
      const profile = styleProfiles.get(id);
      if (!profile) {
        throw new Error(`Style profile not found: ${id}`);
      }

      const updated: StyleProfile = {
        ...profile,
        ...input,
        updatedAt: now()
      };
      styleProfiles.set(id, updated);
      persist();
      return updated;
    },

    async createSourcePacket(input) {
      const account = accounts.get(input.accountId);
      if (!account) {
        throw new Error(`Account not found: ${input.accountId}`);
      }

      const timestamp = now();
      const packet: SourcePacket = {
        id: id("packet"),
        accountId: input.accountId,
        sourceType: input.sourceType,
        title: input.title,
        url: input.url ?? null,
        summary: input.summary,
        facts: input.facts,
        tweetType: input.tweetType,
        status: "new",
        createdAt: timestamp,
        updatedAt: timestamp
      };
      sourcePackets.set(packet.id, packet);
      persist();
      return packet;
    },

    async getSourcePacket(id) {
      return sourcePackets.get(id) ?? null;
    },

    async getSourcePacketByUrl(url, accountId) {
      return (
        [...sourcePackets.values()].find((packet) => packet.url === url && (!accountId || packet.accountId === accountId)) ??
        null
      );
    },

    async listSourcePackets(accountId) {
      return [...sourcePackets.values()]
        .filter((packet) => !accountId || packet.accountId === accountId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async deleteSourcePacket(id) {
      const packet = sourcePackets.get(id);
      if (!packet) {
        throw new Error(`Source packet not found: ${id}`);
      }
      sourcePackets.delete(id);
      persist();
      return packet;
    },

    async markSourcePacketDrafted(id) {
      const packet = sourcePackets.get(id);
      if (!packet) {
        throw new Error(`Source packet not found: ${id}`);
      }
      const updated: SourcePacket = { ...packet, status: "drafted", updatedAt: now() };
      sourcePackets.set(id, updated);
      persist();
      return updated;
    },

    async resetSourcePacket(id) {
      const packet = sourcePackets.get(id);
      if (!packet) {
        throw new Error(`Source packet not found: ${id}`);
      }
      const updated: SourcePacket = { ...packet, status: "new", updatedAt: now() };
      sourcePackets.set(id, updated);
      persist();
      return updated;
    },

    async createDraft(input) {
      const account = accounts.get(input.accountId);
      if (!account) {
        throw new Error(`Account not found: ${input.accountId}`);
      }
      (input.candidates ?? []).forEach((candidate) => assertTweetTextFitsLimit(candidate.text));

      const timestamp = now();
      const firstCandidate = input.candidates && input.candidates.length > 0 ? (input.candidates[0]?.text ?? null) : null;
      const draft: Draft = {
        id: id("draft"),
        accountId: input.accountId,
        sourceType: "text",
        sourceInput: input.sourceInput,
        generatedText: firstCandidate,
        editedText: firstCandidate,
        replyTo: input.replyTo ?? (input.replyToUrl ? (parseReplyTargetUrl(input.replyToUrl) ?? undefined) : undefined),
        replyToUrl: input.replyToUrl ?? null,
        metadata: input.metadata ?? {},
        status: firstCandidate ? "selected" : "created",
        createdAt: timestamp,
        updatedAt: timestamp
      };

      drafts.set(draft.id, draft);

      const createdCandidates = (input.candidates ?? []).map((candidate, index): DraftCandidate => {
        const draftCandidate = {
          id: id("candidate"),
          draftId: draft.id,
          text: candidate.text,
          score: { ...candidate.score, index },
          selected: index === 0,
          createdAt: timestamp
        };
        candidates.set(draftCandidate.id, draftCandidate);
        return draftCandidate;
      });

      persist();
      return { draft, candidates: createdCandidates };
    },

    async hasDrafts() {
      return drafts.size > 0;
    },

    async getDraft(id) {
      const draft = drafts.get(id);
      return draft ? { draft, candidates: candidatesForDraft(id) } : null;
    },

    async getDraftBySourcePacketId(sourcePacketId) {
      const candidate = [...candidates.values()].find((item) => item.score.sourcePacketId === sourcePacketId);
      if (candidate) {
        const draft = drafts.get(candidate.draftId);
        return draft ? { draft, candidates: candidatesForDraft(draft.id) } : null;
      }

      const draft = [...drafts.values()].find((item) => item.metadata.sourcePacketId === sourcePacketId);
      return draft ? { draft, candidates: candidatesForDraft(draft.id) } : null;
    },

    async deleteDraft(id) {
      const draft = requireDraft(id);
      const draftCandidates = candidatesForDraft(id);
      const draftJobs = [...jobs.values()].filter((job) => job.draftId === id);
      const historyItem = [...history.values()].find((item) => item.draftId === id);
      if (historyItem) {
        throw new Error(`Cannot delete draft with post history: ${historyItem.id}`);
      }
      const blockedJob = draftJobs.find((job) => job.status === "running" || job.status === "posted");
      if (blockedJob) {
        throw new Error(`Cannot delete draft with ${blockedJob.status} job: ${blockedJob.id}`);
      }

      for (const job of draftJobs) {
        for (const [attemptId, attempt] of attempts.entries()) {
          if (attempt.jobId === job.id) {
            attempts.delete(attemptId);
          }
        }
        jobs.delete(job.id);
      }
      for (const candidate of draftCandidates) {
        candidates.delete(candidate.id);
      }
      for (const [fingerprintId, fingerprint] of fingerprints.entries()) {
        if (fingerprint.draftId === id) {
          fingerprints.delete(fingerprintId);
        }
      }
      drafts.delete(id);
      persist();
      return { draft, candidates: draftCandidates };
    },

    async listPendingDrafts() {
      return [...drafts.values()]
        .filter((draft) => draft.status === "created")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async listQualityGateFailedDrafts() {
      return [...drafts.values()]
        .filter((draft) =>
          ["created", "generated", "selected"].includes(draft.status) &&
          typeof draft.metadata.qualityGate === "object" &&
          draft.metadata.qualityGate !== null &&
          !Array.isArray(draft.metadata.qualityGate)
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((draft) => ({ draft, candidates: candidatesForDraft(draft.id) }));
    },

    async saveDraftCandidates(draftId, inputCandidates) {
      const draft = requireDraft(draftId);
      if (draft.status !== "created") {
        throw new Error(`Cannot save candidates for draft with status: ${draft.status}`);
      }
      inputCandidates.forEach((candidate) => assertTweetTextFitsLimit(candidate.text));

      const timestamp = now();
      const firstCandidate = inputCandidates.length > 0 ? (inputCandidates[0]?.text ?? null) : null;
      const updatedDraft: Draft = {
        ...draft,
        generatedText: firstCandidate,
        editedText: firstCandidate,
        status: firstCandidate ? "selected" : "generated",
        updatedAt: timestamp
      };
      drafts.set(draftId, updatedDraft);

      inputCandidates.forEach((candidate, index) => {
        const draftCandidate = {
          id: id("candidate"),
          draftId,
          text: candidate.text,
          score: { ...candidate.score, index },
          selected: index === 0,
          createdAt: timestamp
        };
        candidates.set(draftCandidate.id, draftCandidate);
      });

      persist();
      return { draft: updatedDraft, candidates: candidatesForDraft(draftId) };
    },

    async updateDraftMetadata(draftId, metadata) {
      const draft = requireDraft(draftId);
      const updated: Draft = { ...draft, metadata, updatedAt: now() };
      drafts.set(draftId, updated);
      persist();
      return updated;
    },

    async selectCandidate(input) {
      const draft = requireDraft(input.draftId);
      if (!canTransitionDraft(draft.status, "selected") && draft.status !== "selected") {
        throw new Error(`Cannot select candidate from draft status: ${draft.status}`);
      }

      const selected = candidates.get(input.candidateId);
      if (!selected || selected.draftId !== input.draftId) {
        throw new Error(`Candidate not found for draft: ${input.candidateId}`);
      }
      assertTweetTextFitsLimit(input.editedText ?? selected.text);

      for (const candidate of candidatesForDraft(input.draftId)) {
        candidates.set(candidate.id, { ...candidate, selected: candidate.id === selected.id });
      }

      const timestamp = now();
      const updatedDraft: Draft = {
        ...draft,
        generatedText: selected.text,
        editedText: input.editedText ?? selected.text,
        status: "selected",
        updatedAt: timestamp
      };
      drafts.set(updatedDraft.id, updatedDraft);

      persist();
      return { draft: updatedDraft, candidates: candidatesForDraft(input.draftId) };
    },

    async approveDraft(input) {
      const draft = requireDraft(input.draftId);
      if (!canTransitionDraft(draft.status, "approved")) {
        throw new Error(`Cannot approve draft from status: ${draft.status}`);
      }
      assertTweetTextFitsLimit(input.editedText);

      const timestamp = now();
      const normalizedText = normalizePostText(input.editedText);
      const textHash = hashPostText(input.editedText);
      const duplicate = [...fingerprints.values()].find(
        (fingerprint) => fingerprint.accountId === draft.accountId && fingerprint.textHash === textHash
      );
      if (duplicate) {
        throw new Error("Duplicate post text for this account");
      }

      const updatedDraft: Draft = {
        ...draft,
        editedText: input.editedText,
        status: "approved",
        updatedAt: timestamp
      };
      drafts.set(updatedDraft.id, updatedDraft);

      const jobMode = input.mode ?? (input.scheduledFor ? "scheduled" : "prepare_only");
      let scheduledFor: string | null = input.scheduledFor ?? null;
      if (!scheduledFor && jobMode === "autopost") {
        const accountJobs = [...jobs.values()]
          .filter((j) => j.accountId === draft.accountId && j.mode === "autopost")
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const lastAutopost = accountJobs[0];
        const lastScheduledFor = lastAutopost?.scheduledFor ?? null;
        const recentGapMs: number[] = [];
        for (let i = 0; i < accountJobs.length - 1; i += 1) {
          const curr = accountJobs[i];
          const next = accountJobs[i + 1];
          if (!curr || !next) continue;
          const currMs = Date.parse(curr.scheduledFor ?? curr.createdAt);
          const nextMs = Date.parse(next.scheduledFor ?? next.createdAt);
          if (Number.isFinite(currMs) && Number.isFinite(nextMs)) {
            recentGapMs.push(Math.abs(currMs - nextMs));
          }
        }
        const gapMinMinutes = Number(process.env.ZYQUOR_POST_GAP_MIN_MINUTES ?? 30);
        const gapMaxMinutes = Number(process.env.ZYQUOR_POST_GAP_MAX_MINUTES ?? 90);
        const next = nextAutopostScheduledFor({
          lastScheduledFor,
          timestamp,
          gapMinMinutes,
          gapMaxMinutes,
          recentGapMs
        });
        scheduledFor = next.scheduledFor;
      }
      const job: PostJob = {
        id: id("job"),
        accountId: draft.accountId,
        draftId: draft.id,
        status: "approved",
        mode: jobMode,
        scheduledFor,
        replyTo: input.replyTo ?? draft.replyTo ?? (input.replyToUrl ? (parseReplyTargetUrl(input.replyToUrl) ?? undefined) : undefined),
        replyToUrl: input.replyToUrl ?? draft.replyToUrl ?? null,
        approvedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      jobs.set(job.id, job);
      const fingerprint: ContentFingerprint = {
        id: id("fingerprint"),
        accountId: draft.accountId,
        draftId: draft.id,
        textHash,
        normalizedText,
        embeddingRef: null,
        createdAt: timestamp
      };
      fingerprints.set(fingerprint.id, fingerprint);

      persist();
      return { draft: updatedDraft, job };
    },

    async listJobs() {
      return [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async getJob(id) {
      return jobs.get(id) ?? null;
    },

    async deleteJob(id) {
      const job = requireJob(id);
      if (job.status === "running") {
        throw new Error("Cannot delete a running job");
      }
      jobs.delete(id);
      for (const [attemptId, attempt] of attempts.entries()) {
        if (attempt.jobId === id) {
          attempts.delete(attemptId);
        }
      }
      persist();
      return job;
    },

    async updateJobStatus(id, status) {
      const job = requireJob(id);
      if (!canTransitionPostJob(job.status, status) && job.status !== status) {
        throw new Error(`Cannot move job from ${job.status} to ${status}`);
      }

      const updatedJob = { ...job, status, updatedAt: now() };
      jobs.set(id, updatedJob);
      persist();
      return updatedJob;
    },

    async assignJobSchedule(id, scheduledFor) {
      const job = requireJob(id);
      const updatedJob = { ...job, scheduledFor, updatedAt: now() };
      jobs.set(id, updatedJob);
      persist();
      return updatedJob;
    },

    async claimJobForBrowserRun(id, claimableStatuses) {
      const job = jobs.get(id);
      if (!job || !claimableStatuses.includes(job.status)) {
        return null;
      }
      const hasOtherActiveJob = [...jobs.values()].some(
        (candidate) =>
          candidate.accountId === job.accountId &&
          candidate.id !== job.id &&
          (candidate.status === "queued" || candidate.status === "running")
      );
      if (hasOtherActiveJob) {
        return null;
      }

      const claimed: PostJob = { ...job, status: "queued", updatedAt: now() };
      jobs.set(id, claimed);
      persist();
      return claimed;
    },

    async createAttempt(input) {
      const timestamp = now();
      const attempt: PostAttempt = {
        id: id("attempt"),
        jobId: input.jobId,
        status: input.status,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        screenshotPath: input.screenshotPath ?? null,
        tracePath: input.tracePath ?? null,
        startedAt: timestamp,
        finishedAt: input.status === "failed" || input.status === "verified" ? timestamp : null
      };
      attempts.set(attempt.id, attempt);
      persist();
      return attempt;
    },

    async listAttempts(jobId) {
      return [...attempts.values()].filter((attempt) => attempt.jobId === jobId);
    },

    async createIngestRun(input) {
      const run: IngestRun = {
        id: id("ingest_run"),
        configId: input.configId,
        accountId: input.accountId,
        startedAt: now(),
        finishedAt: null,
        status: "running",
        error: null,
        packetsCreated: 0
      };
      ingestRuns.set(run.id, run);
      persist();
      return run;
    },

    async updateIngestRun(id, input) {
      const run = ingestRuns.get(id);
      if (!run) throw new Error(`Ingest run ${id} not found`);
      const updated: IngestRun = {
        ...run,
        status: input.status,
        error: input.error === undefined ? run.error : input.error,
        packetsCreated: input.packetsCreated ?? run.packetsCreated,
        finishedAt: input.status === "running" ? null : now()
      };
      ingestRuns.set(id, updated);
      persist();
      return updated;
    },

    async listIngestRuns(accountId, limit = 50) {
      return [...ingestRuns.values()]
        .filter((run) => !accountId || run.accountId === accountId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id))
        .slice(0, Math.min(50, Math.max(0, limit)));
    },

    async recoverRunningIngestRuns() {
      let recoveredCount = 0;
      for (const [id, run] of ingestRuns.entries()) {
        if (run.status !== "running") continue;
        ingestRuns.set(id, { ...run, status: "failed", error: "interrupted", finishedAt: now() });
        recoveredCount += 1;
      }
      if (recoveredCount > 0) persist();
      return recoveredCount;
    },

    async createPostHistory(input) {
      const item: PostHistory = {
        id: id("history"),
        accountId: input.accountId,
        draftId: input.draftId,
        metadata: input.metadata ?? {},
        postedText: input.postedText,
        postUrl: input.postUrl,
        sourcePacketId: input.sourcePacketId ?? null,
        sourceTitle: input.sourceTitle ?? null,
        sourceType: input.sourceType ?? null,
        sourceUrl: input.sourceUrl ?? null,
        tweetType: input.tweetType ?? null,
        postedAt: now()
      };
      history.set(item.id, item);
      persist();
      return item;
    },

    async listPostHistory() {
      return [...history.values()].sort((a, b) => b.postedAt.localeCompare(a.postedAt));
    },

    async purgePostHistoryOlderThan(cutoffIso) {
      let deletedCount = 0;
      for (const [id, item] of history.entries()) {
        if (item.postedAt < cutoffIso) {
          history.delete(id);
          deletedCount += 1;
        }
      }
      if (deletedCount > 0) {
        persist();
      }
      return deletedCount;
    },

    async createIngestConfig(input) {
      const nowStr = now();
      const config: IngestConfig = {
        id: id("ingest"),
        accountId: input.accountId,
        sourceType: input.sourceType,
        maxPacketsPerDay: input.maxPacketsPerDay,
        metadata: input.metadata ?? {},
        tweetTypeMix: input.tweetTypeMix,
        scheduleWindowStart: input.scheduleWindowStart,
        scheduleWindowEnd: input.scheduleWindowEnd,
        enabled: input.enabled,
        createdAt: nowStr,
        updatedAt: nowStr
      };
      ingestConfigs.set(config.id, config);
      persist();
      return config;
    },

    async getIngestConfig(id) {
      return ingestConfigs.get(id) ?? null;
    },

    async listIngestConfigs(accountId) {
      const all = [...ingestConfigs.values()];
      return accountId ? all.filter((c) => c.accountId === accountId) : all;
    },

    async updateIngestConfig(id, input) {
      const existing = ingestConfigs.get(id);
      if (!existing) throw new Error(`Ingest config ${id} not found`);
      const updated: IngestConfig = { ...existing, ...input, updatedAt: now() };
      ingestConfigs.set(id, updated);
      persist();
      return updated;
    },

    async deleteIngestConfig(id) {
      const existing = ingestConfigs.get(id);
      if (!existing) throw new Error(`Ingest config ${id} not found`);
      ingestConfigs.delete(id);
      persist();
      return existing;
    }
  };
}

export function createJsonFileRepository(filePath = defaultJsonDatabasePath()): ZyquorRepository {
  mkdirSync(dirname(filePath), { recursive: true });

  let snapshot: Partial<RepositorySnapshot> | undefined;
  try {
    snapshot = JSON.parse(readFileSync(filePath, "utf8")) as RepositorySnapshot;
  } catch {
    snapshot = undefined;
  }

  return createMemoryRepository({
    ...(snapshot ? { snapshot } : {}),
    onChange(nextSnapshot) {
      writeFileSync(filePath, `${JSON.stringify(nextSnapshot, null, 2)}\n`);
    }
  });
}
