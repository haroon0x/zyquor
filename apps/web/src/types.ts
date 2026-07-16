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
}

export interface Candidate {
  id: string;
  text: string;
  selected: boolean;
}

export interface DraftResponse {
  draft: Draft;
  candidates: Candidate[];
}

export interface Job {
  id: string;
  accountId: string;
  draftId: string;
  status: string;
  mode: string;
  scheduledFor: string | null;
  approvedAt: string | null;
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
  llmProvider?: string;
  openrouterApiKey?: string;
  geminiApiKey?: string;
  chromePath?: string;
  cdpPort?: number;
  startWithWindows?: boolean;
  restartRequired?: boolean;
}

export interface PanelProps {
  accountId: string;
  busy: boolean;
  refreshToken: number;
  refresh: () => Promise<void>;
  run: (action: () => Promise<void>) => void;
  reportError: (error: unknown, fallback: string) => void;
}

export const X_FREE_POST_CHARACTER_LIMIT = 280;

export const tweetTypeOptions = [
  "feed_observation",
  "news_context",
  "useful_info",
  "guide",
  "lesson",
  "tool",
  "opinion",
  "reply",
  "hiring",
  "article_summary",
  "narrative_history"
];
