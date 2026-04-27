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

export interface DraftWithCandidates {
  draft: Draft;
  candidates: DraftCandidate[];
}

export interface ZyquorRepository {
  listAccounts(): Promise<Account[]>;
  getAccount(id: string): Promise<Account | null>;
  updateAccount(id: string, input: Partial<Omit<Account, "id" | "createdAt" | "updatedAt">>): Promise<Account>;
  getStyleProfile(id: string): Promise<StyleProfile | null>;
  updateStyleProfile(id: string, input: Partial<Omit<StyleProfile, "id" | "createdAt" | "updatedAt">>): Promise<StyleProfile>;
  createDraft(input: {
    accountId: string;
    sourceInput: string;
    candidates: Array<{ text: string; score: Record<string, unknown> }>;
  }): Promise<DraftWithCandidates>;
  createSourcePacket(input: {
    accountId: string;
    sourceType: SourcePacket["sourceType"];
    title: string;
    url?: string | null;
    summary: string;
    facts: string[];
    tweetType: SourcePacket["tweetType"];
  }): Promise<SourcePacket>;
  getSourcePacket(id: string): Promise<SourcePacket | null>;
  getSourcePacketByUrl(url: string, accountId?: string): Promise<SourcePacket | null>;
  listSourcePackets(accountId?: string): Promise<SourcePacket[]>;
  markSourcePacketDrafted(id: string): Promise<SourcePacket>;
  getDraft(id: string): Promise<DraftWithCandidates | null>;
  selectCandidate(input: { draftId: string; candidateId: string; editedText?: string }): Promise<DraftWithCandidates>;
  approveDraft(input: {
    draftId: string;
    editedText: string;
    mode?: PostJob["mode"];
    scheduledFor?: string | null;
  }): Promise<{ draft: Draft; job: PostJob }>;
  listJobs(): Promise<PostJob[]>;
  getJob(id: string): Promise<PostJob | null>;
  deleteJob(id: string): Promise<PostJob>;
  updateJobStatus(id: string, status: PostJob["status"]): Promise<PostJob>;
  createAttempt(input: {
    jobId: string;
    status: PostAttempt["status"];
    errorCode?: string | null;
    errorMessage?: string | null;
    screenshotPath?: string | null;
    tracePath?: string | null;
  }): Promise<PostAttempt>;
  listAttempts(jobId: string): Promise<PostAttempt[]>;
  createPostHistory(input: {
    accountId: string;
    draftId: string;
    postedText: string;
    postUrl: string | null;
  }): Promise<PostHistory>;
  listPostHistory(): Promise<PostHistory[]>;
  createIngestConfig(input: {
    accountId: string;
    sourceType: SourcePacket["sourceType"];
    maxPacketsPerDay: number;
    tweetTypeMix: Record<string, number>;
    scheduleWindowStart: string;
    scheduleWindowEnd: string;
    enabled: boolean;
  }): Promise<IngestConfig>;
  getIngestConfig(id: string): Promise<IngestConfig | null>;
  listIngestConfigs(accountId?: string): Promise<IngestConfig[]>;
  updateIngestConfig(id: string, input: Partial<Omit<IngestConfig, "id" | "accountId" | "createdAt" | "updatedAt">>): Promise<IngestConfig>;
  deleteIngestConfig(id: string): Promise<IngestConfig>;
}

export interface ContentFingerprint {
  id: string;
  accountId: string;
  draftId: string;
  textHash: string;
  normalizedText: string;
  embeddingRef: string | null;
  createdAt: string;
}

export interface RepositorySnapshot {
  accounts: Account[];
  drafts: Draft[];
  candidates: DraftCandidate[];
  jobs: PostJob[];
  attempts: PostAttempt[];
  history: PostHistory[];
  fingerprints: ContentFingerprint[];
  sourcePackets: SourcePacket[];
  styleProfiles: StyleProfile[];
  sequence: number;
}
