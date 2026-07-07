import type { SourceAdapter } from "@zyquor/adapters";
import type { DraftGenerationProvider, GenerationEnvironment } from "@zyquor/generation";
import type { ZyquorRepository } from "@zyquor/storage";

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
    url: string;
  }>;
  preparePost?: (input: {
    actionDelayMs?: number;
    browserChannel?: string | null;
    cdpUrl?: string;
    closeAfterPrepare?: boolean;
    mediaPaths?: string[];
    profileDir: string;
    submit?: boolean;
    text: string;
    typingDelayMs?: number;
  }) => Promise<{ postUrl: string | null }>;
  closeAfterPrepare?: boolean;
  closeAfterPost?: boolean;
  launchPostingChrome?: (input: { accountId: string }) => Promise<{ launched: boolean; reason?: string }>;
}

export interface AppDeps {
  repository: Promise<ZyquorRepository>;
  sourceAdapters: Map<string, SourceAdapter>;
  generationEnv: GenerationEnvironment;
  generationProvider: DraftGenerationProvider;
  generationConfigPath: string | null;
  launchPostingChrome: ((input: { accountId: string }) => Promise<{ launched: boolean; reason?: string }>) | undefined;
  workerHeartbeat: {
    lastError: string | null;
    lastHeartbeatAt: string;
    lastIngestAt: string | null;
    lastPostAt: string | null;
  } | null;
  ingestRunState: {
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
      packetCap: number;
      scheduleWindow: number;
      thinContext: number;
      topicOverlap: number;
    };
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
    closeAfterPrepare?: boolean | undefined;
    closeAfterPost?: boolean | undefined;
  };
}
