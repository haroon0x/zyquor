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
import { canTransitionDraft, canTransitionPostJob } from "@zyquor/core";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ZyquorRepository, RepositorySnapshot, ContentFingerprint } from "./types.js";
import { id as idGen, normalizePostText, hashPostText } from "./utils.js";

export const DEFAULT_JSON_DATABASE_PATH = "data/app.json";

export interface MemoryRepositoryOptions {
  now?: () => string;
  snapshot?: Partial<RepositorySnapshot>;
  onChange?: (snapshot: RepositorySnapshot) => void;
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
      dailyPostLimit: 1000,
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
  const history = new Map<string, PostHistory>((options.snapshot?.history ?? []).map((item) => [item.id, item]));
  const fingerprints = new Map<string, ContentFingerprint>(
    (options.snapshot?.fingerprints ?? []).map((item) => [item.id, item])
  );
  const sourcePackets = new Map<string, SourcePacket>(
    (options.snapshot?.sourcePackets ?? []).map((packet) => [packet.id, packet])
  );
  const ingestConfigs = new Map<string, IngestConfig>();
  let sequence = options.snapshot?.sequence ?? 0;

  function snapshot(): RepositorySnapshot {
    return {
      accounts: [...accounts.values()],
      drafts: [...drafts.values()],
      candidates: [...candidates.values()],
      jobs: [...jobs.values()],
      attempts: [...attempts.values()],
      history: [...history.values()],
      fingerprints: [...fingerprints.values()],
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

    async getAccount(id) {
      return accounts.get(id) ?? null;
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

    async createDraft(input) {
      const account = accounts.get(input.accountId);
      if (!account) {
        throw new Error(`Account not found: ${input.accountId}`);
      }

      const timestamp = now();
      const firstCandidate = input.candidates && input.candidates.length > 0 ? (input.candidates[0]?.text ?? null) : null;
      const draft: Draft = {
        id: id("draft"),
        accountId: input.accountId,
        sourceType: "text",
        sourceInput: input.sourceInput,
        generatedText: firstCandidate,
        editedText: firstCandidate,
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

    async getDraft(id) {
      const draft = drafts.get(id);
      return draft ? { draft, candidates: candidatesForDraft(id) } : null;
    },

    async listPendingDrafts() {
      return [...drafts.values()]
        .filter((draft) => draft.status === "created")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async saveDraftCandidates(draftId, inputCandidates) {
      const draft = requireDraft(draftId);
      if (draft.status !== "created") {
        throw new Error(`Cannot save candidates for draft with status: ${draft.status}`);
      }

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

    async selectCandidate(input) {
      const draft = requireDraft(input.draftId);
      if (!canTransitionDraft(draft.status, "selected") && draft.status !== "selected") {
        throw new Error(`Cannot select candidate from draft status: ${draft.status}`);
      }

      const selected = candidates.get(input.candidateId);
      if (!selected || selected.draftId !== input.draftId) {
        throw new Error(`Candidate not found for draft: ${input.candidateId}`);
      }

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
      const job: PostJob = {
        id: id("job"),
        accountId: draft.accountId,
        draftId: draft.id,
        status: "approved",
        mode: jobMode,
        scheduledFor: input.scheduledFor ?? null,
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

    async createPostHistory(input) {
      const item: PostHistory = {
        id: id("history"),
        accountId: input.accountId,
        draftId: input.draftId,
        postedText: input.postedText,
        postUrl: input.postUrl,
        postedAt: now()
      };
      history.set(item.id, item);
      persist();
      return item;
    },

    async listPostHistory() {
      return [...history.values()].sort((a, b) => b.postedAt.localeCompare(a.postedAt));
    },

    async createIngestConfig(input) {
      const nowStr = now();
      const config: IngestConfig = {
        id: id("ingest"),
        accountId: input.accountId,
        sourceType: input.sourceType,
        maxPacketsPerDay: input.maxPacketsPerDay,
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

export function createJsonFileRepository(filePath = DEFAULT_JSON_DATABASE_PATH): ZyquorRepository {
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
