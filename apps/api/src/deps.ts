import type { GoldfishContextBundle, GoldfishContextInput, SourceAdapter } from "@zyquor/adapters";
import type {
  FetchAccountTimelineInput,
  FetchAccountTimelineResult,
  FetchTweetInput,
  FetchTweetResult,
  FetchXHomeFeedInput,
  FetchXHomeFeedResult,
  FetchXMentionsInput,
  FetchXMentionsResult
} from "@zyquor/browser";
import type { DraftGenerationProvider, GenerationEnvironment } from "@zyquor/generation";
import type { ZyquorRepository } from "@zyquor/storage";
import type { ReplyTarget } from "@zyquor/core";

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
  feedbackDir?: string;
  autoApproveSourcePackets?: boolean;
}

export interface DesktopSettingsConfig {
  get(): DesktopSettingsData;
  update(patch: DesktopSettingsData): DesktopSettingsData;
}

export interface DesktopRuntimeStatus {
  appVersion: string;
  chromeConnected: boolean;
  chromePid: number | null;
  cdpUrl: string;
  dataRoot: string;
  logPath: string;
  platform: string;
  startedAt: string;
  workerPaused: boolean;
}

export interface DesktopControl {
  closeChrome(): Promise<{ closed: boolean; reason?: string }>;
  logTail(lines: number): Promise<string[]>;
  quit(): Promise<void>;
  restart(): Promise<void>;
  setWorkerPaused(paused: boolean): Promise<boolean>;
  status(): Promise<DesktopRuntimeStatus>;
}

export interface BuildAppOptions {
  repository?: ZyquorRepository;
  generationProvider?: DraftGenerationProvider;
  generationConfigPath?: string | null;
  generationEnv?: GenerationEnvironment;
  enableBrowserPrepare?: boolean;
  enableBrowserPost?: boolean;
  browserActionDelayMs?: number;
  browserChannel?: string | null;
  browserCdpUrl?: string;
  browserTypingDelayMs?: number;
  sourceAdapters?: SourceAdapter[];
  checkXLogin?: (input: { browserChannel?: string | null; cdpUrl?: string; profileDir: string }) => Promise<{
    loggedIn: boolean;
    url?: string | null;
    /** Screen name actually logged in, lowercase, no @; null/absent = unverified. */
    handle?: string | null;
  }>;
  preparePost?: (input: {
    actionDelayMs?: number;
    browserChannel?: string | null;
    cdpUrl?: string;
    closeAfterPrepare?: boolean;
    mediaPaths?: string[];
    profileDir: string;
    replyTo?: ReplyTarget;
    submit?: boolean;
    text: string;
    typingDelayMs?: number;
  }) => Promise<{ postUrl: string | null }>;
  deletePost?: (input: {
    actionDelayMs?: number;
    browserChannel?: string | null;
    cdpUrl?: string;
    profileDir: string;
    postUrl: string;
  }) => Promise<{ status: "deleted"; postUrl: string; alreadyDeleted: boolean }>;
  fetchTweet?: (input: FetchTweetInput) => Promise<FetchTweetResult>;
  fetchAccountTimeline?: (input: FetchAccountTimelineInput) => Promise<FetchAccountTimelineResult>;
  fetchXHomeFeed?: (input: FetchXHomeFeedInput) => Promise<FetchXHomeFeedResult>;
  fetchXMentions?: (input: FetchXMentionsInput) => Promise<FetchXMentionsResult>;
  goldfishReplyContext?: (input: GoldfishContextInput) => Promise<GoldfishContextBundle | null>;
  closeAfterPrepare?: boolean;
  closeAfterPost?: boolean;
  launchPostingChrome?: (input: { accountId: string }) => Promise<{ launched: boolean; reason?: string }>;
  desktopSettings?: DesktopSettingsConfig;
  desktopControl?: DesktopControl;
  logStream?: { write(chunk: string): void };
}

export interface AppDeps {
  repository: Promise<ZyquorRepository>;
  sourceAdapters: Map<string, SourceAdapter>;
  generationEnv: GenerationEnvironment;
  generationProvider: DraftGenerationProvider;
  generationConfigPath: string | null;
  goldfishReplyContext: (input: GoldfishContextInput) => Promise<GoldfishContextBundle | null>;
  launchPostingChrome: ((input: { accountId: string }) => Promise<{ launched: boolean; reason?: string }>) | undefined;
  desktopSettings: DesktopSettingsConfig | undefined;
  desktopControl: DesktopControl | undefined;
  workerHeartbeat: {
    lastError: string | null;
    lastHeartbeatAt: string;
    lastIngestAt: string | null;
    lastPostAt: string | null;
  } | null;
  ingestRunState: {
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
  browserLoaded: boolean;
  onboarding: {
    xSessionCheckedOk: boolean;
  };
  browser: {
    enablePrepare: boolean;
    enablePost: boolean;
    actionDelayMs?: number | undefined;
    channel?: string | null | undefined;
    cdpUrl?: string | undefined;
    typingDelayMs?: number | undefined;
    checkXLogin?: BuildAppOptions["checkXLogin"] | undefined;
    preparePost?: BuildAppOptions["preparePost"] | undefined;
    deletePost?: BuildAppOptions["deletePost"] | undefined;
    closeAfterPrepare?: boolean | undefined;
    closeAfterPost?: boolean | undefined;
    fetchTweet: (input: FetchTweetInput) => Promise<FetchTweetResult>;
    fetchAccountTimeline: (input: FetchAccountTimelineInput) => Promise<FetchAccountTimelineResult>;
    fetchXHomeFeed: (input: FetchXHomeFeedInput) => Promise<FetchXHomeFeedResult>;
    fetchXMentions: (input: FetchXMentionsInput) => Promise<FetchXMentionsResult>;
  };
}
