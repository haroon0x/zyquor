export interface Account {
  id: string;
  displayName: string;
  handle: string;
  postingMode: string;
  profileDir: string;
  styleProfileId: string;
  enabled: boolean;
  dailyPostLimit: number | null;
  quietHoursEnd: string | null;
  quietHoursStart: string | null;
}

export interface Draft {
  id: string;
  accountId?: string;
  sourceInput: string;
  editedText: string | null;
  metadata?: Record<string, unknown>;
  replyTo?: ReplyTarget;
  status: string;
}

export interface ReplyTarget {
  tweetId: string;
  authorHandle: string;
  url: string;
  authorName?: string;
  text?: string;
}

export interface Candidate {
  id: string;
  text: string;
  selected: boolean;
  score: Record<string, unknown> & {
    judgeScore?: number;
    judgeVerdict?: "strong" | "ok" | "weak";
    judgeReasons?: string[];
    judgedAt?: string;
    judgeModel?: string;
  };
}

export interface DraftResponse {
  draft: Draft;
  candidates: Candidate[];
}

export interface QualityGateMetadata {
  bestQuality: number | null;
  threshold: number;
  slopPhrase: string | null;
  reason: string;
  rejectedAt: string;
}

export interface QualityGateFailure extends DraftResponse {
  qualityGate: QualityGateMetadata;
}

export interface Job {
  id: string;
  accountId: string;
  draftId: string;
  status: string;
  mode: string;
  scheduledFor: string | null;
  approvedAt: string | null;
  createdAt: string;
  replyTo?: ReplyTarget;
}

export interface Attempt {
  id: string;
  jobId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  screenshotPath: string | null;
  tracePath: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface PostHistory {
  id: string;
  accountId: string;
  draftId: string;
  postedText: string;
  postUrl: string | null;
  sourcePacketId: string | null;
  sourceType: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
  tweetType: string | null;
  metadata: Record<string, unknown>;
  postedAt: string;
}

export interface GenerationConfig {
  provider: string;
  model: string;
  configured: boolean;
  baseUrl?: string;
}

export type GenerationModelOptions = Record<string, string[]>;

export interface GenerationResponse {
  generation: GenerationConfig;
  providers: GenerationModelOptions;
}

export interface OnboardingStatus {
  needsOnboarding: boolean;
  accountsCount: number;
  hasDrafts: boolean;
  hasJobs: boolean;
  generation: GenerationConfig & { isDefault: boolean };
  xSessionCheckedOk: boolean;
}

export interface BrowserSession {
  accountId: string;
  cdpUrl: string | null;
  enabled: boolean;
  error: string | null;
  loggedIn: boolean;
  profileDir: string;
  url: string | null;
}

export interface SourcePacket {
  id: string;
  accountId: string;
  facts: string[];
  sourceType: string;
  status: string;
  summary: string;
  title: string;
  tweetType: string;
  url: string | null;
  feedback: string | null | undefined;
}

export interface SystemFeedback {
  id: string;
  accountId: string;
  text: string;
  createdAt: string;
}

export type KnowledgeKind =
  | "product_fact"
  | "feature"
  | "pricing"
  | "persona"
  | "opinion_stance"
  | "audience"
  | "faq"
  | "never_claim";

export interface KnowledgeEntry {
  id: string;
  accountId: string;
  kind: KnowledgeKind;
  title: string;
  content: string;
  sourceUrl: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IngestConfig {
  id: string;
  accountId: string;
  enabled: boolean;
  maxPacketsPerDay: number;
  metadata: Record<string, unknown>;
  scheduleWindowEnd: string;
  scheduleWindowStart: string;
  sourceType: string;
  tweetTypeMix: Record<string, number>;
}

export interface IngestRun {
  id: string;
  configId: string;
  accountId: string;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "succeeded" | "failed";
  error: string | null;
  packetsCreated: number;
}

export interface WorkerStatus {
  workerRunning: boolean;
  lastHeartbeatAt: string | null;
  lastError: string | null;
}

export interface StyleProfile {
  id: string;
  name: string;
  description: string | null;
  tone: string | null;
  rules: Record<string, unknown>;
  bannedPhrases: string[];
  examplePosts: string[];
}

export interface DesktopSettingsData {
  enableBrowserPrepare?: boolean;
  enableBrowserPost?: boolean;
  closeChromeAfterPost?: boolean;
  commandCodePath?: string;
  opencodePath?: string;
  opencodeVariant?: string;
  llmProvider?: string;
  openrouterApiKey?: string;
  geminiApiKey?: string;
  chromePath?: string;
  cdpPort?: number;
  startWithWindows?: boolean;
  restartRequired?: boolean;
  feedbackDir?: string;
  autoApproveSourcePackets?: boolean;
}

export interface SystemStatus {
  api: {
    startedAt: string;
    browserLoaded: boolean;
  };
  counts: {
    drafts: number;
    ingestConfigsEnabled: number;
    jobs: number;
    jobsByStatus: Record<string, number>;
    sourcePackets: number;
  };
  desktop: {
    appVersion: string;
    cdpUrl: string;
    chromeConnected: boolean;
    chromePid: number | null;
    dataRoot: string;
    logPath: string;
    platform: string;
    startedAt: string;
    workerPaused: boolean;
  } | null;
  generation: {
    model: string;
    provider: string;
  };
  runningJobs: Array<{ accountId: string; id: string; mode: string; updatedAt: string }>;
  ingestRun: {
    cancelRequested?: boolean;
    errors: Array<{ configId: string; error: string }>;
    finishedAt: string | null;
    lastStartedAt: string | null;
    processed: number;
    running: boolean;
    skippedByReason?: {
      blockedUrl: number;
      duplicatePacket: number;
      duplicatePostedUrl: number;
      hostCap: number;
      offTopic: number;
      packetCap: number;
      scheduleWindow: number;
      thinContext: number;
      topicOverlap: number;
    };
  };
  posting: {
    cdpUrl: string | null;
    channel: string | null;
    enablePost: boolean;
    enablePrepare: boolean;
    autoApproveSourcePackets?: boolean;
  };
  worker: {
    lastError: string | null;
    lastHeartbeatAt: string | null;
    lastIngestAt: string | null;
    lastPostAt: string | null;
    paused: boolean;
    running: boolean;
  };
}

export interface PanelProps {
  accountId: string;
  busy: boolean;
  refreshToken: number;
  refresh: () => Promise<void>;
  run: (action: () => Promise<void>) => void;
  reportError: (error: unknown, fallback: string) => void;
}

export const tweetTypeOptions = [
  "useful_info",
  "guide",
  "opinion",
  "reply",
  "narrative_history",
  "feed_observation"
];
