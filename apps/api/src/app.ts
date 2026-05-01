import cors from "@fastify/cors";
import { assertDedicatedProfileDir, isAccountRunnable } from "@zyquor/accounts";
import { createAggregatedNewsAdapter, createCrawl4AiService, createRssAdapter, type SourceAdapter } from "@zyquor/adapters";
import { accountGenerationContext, draftFromSourcePacket, runAutomaticIngest } from "@zyquor/automation";
import {
  approveDraftRequestSchema,
  createDraftBatchRequestSchema,
  createDraftRequestSchema,
  createIngestConfigRequestSchema,
  createSourcePacketRequestSchema,
  prepareJobRequestSchema,
  selectDraftCandidateRequestSchema,
  updateAccountRequestSchema,
  updateGenerationConfigRequestSchema,
  updateIngestConfigRequestSchema,
  updateStyleProfileRequestSchema,
  type PostingMode
} from "@zyquor/core";
import {
  createGenerationProviderFromEnv,
  GENERATION_MODEL_OPTIONS,
  resolveGenerationProviderConfig,
  type DraftGenerationProvider,
  type GenerationEnvironment
} from "@zyquor/generation";
import { createLocalRepository, type ZyquorRepository } from "@zyquor/storage";
import Fastify from "fastify";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { ZodError } from "zod";

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
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function browserArtifacts(error: unknown) {
  const maybeError = error as { screenshotPath?: unknown; tracePath?: unknown };
  return {
    screenshotPath: typeof maybeError.screenshotPath === "string" ? maybeError.screenshotPath : null,
    tracePath: typeof maybeError.tracePath === "string" ? maybeError.tracePath : null
  };
}

function asHttpError(error: unknown) {
  return error instanceof HttpError ? error : null;
}

function isConflictError(error: Error) {
  return (
    error.message.startsWith("Cannot ") ||
    error.message.startsWith("Duplicate ") ||
    error.message.endsWith(" not found")
  );
}

function isGenerationError(error: Error) {
  return (
    error.message.startsWith("Generation request failed:") ||
    error.message.includes(" returned no draft candidates") ||
    error.message.includes("ZYQUOR_OPENROUTER_API_KEY")
  );
}

function asError(error: unknown) {
  return error instanceof Error ? error : new Error("Unknown error");
}

function definedEntries<T extends Record<string, unknown>>(input: T) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function browserOptions(options: BuildAppOptions) {
  return {
    ...(options.browserActionDelayMs !== undefined ? { actionDelayMs: options.browserActionDelayMs } : {}),
    ...(options.browserChannel !== undefined ? { browserChannel: options.browserChannel } : {}),
    ...(options.browserCdpUrl !== undefined ? { cdpUrl: options.browserCdpUrl } : {}),
    ...(options.browserTypingDelayMs !== undefined ? { typingDelayMs: options.browserTypingDelayMs } : {})
  };
}

function workspaceRoot() {
  return process.env.ZYQUOR_WORKSPACE_ROOT ?? resolve(process.cwd(), "../..");
}

function defaultGenerationConfigPath() {
  return resolve(workspaceRoot(), ".zyquor/generation.json");
}

function resolveProfileDir(profileDir: string) {
  return isAbsolute(profileDir) ? profileDir : resolve(workspaceRoot(), profileDir);
}

function mediaUrlsFromDraftMetadata(metadata: Record<string, unknown>) {
  const urls = Array.isArray(metadata.mediaUrls) ? metadata.mediaUrls : [];
  return urls.filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url)).slice(0, 4);
}

function extensionForMedia(url: string, contentType: string | null) {
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  if ([".avif", ".gif", ".jpg", ".jpeg", ".png", ".webp"].includes(fromUrl)) {
    return fromUrl;
  }
  if (contentType?.includes("png")) return ".png";
  if (contentType?.includes("webp")) return ".webp";
  if (contentType?.includes("gif")) return ".gif";
  if (contentType?.includes("avif")) return ".avif";
  return ".jpg";
}

async function downloadMediaUrls(urls: string[]) {
  if (urls.length === 0) {
    return [];
  }

  const mediaDir = resolve(workspaceRoot(), "data/media");
  mkdirSync(mediaDir, { recursive: true });
  const paths: string[] = [];

  for (const url of urls) {
    const response = await fetch(url, { headers: { "user-agent": "Zyquor/1.0" } });
    if (!response.ok) {
      throw new Error(`Media download failed: ${response.status} ${url}`);
    }
    const contentType = response.headers.get("content-type");
    if (contentType && !contentType.toLowerCase().startsWith("image/")) {
      throw new Error(`Media URL is not an image: ${url}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
      throw new Error(`Media size is invalid: ${url}`);
    }
    const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
    const path = resolve(mediaDir, `${hash}${extensionForMedia(url, contentType)}`);
    await writeFile(path, bytes);
    paths.push(path);
  }

  return paths;
}

async function mediaPathsForDraft(draft: { metadata: Record<string, unknown> }) {
  return downloadMediaUrls(mediaUrlsFromDraftMetadata(draft.metadata));
}

async function isDailyLimitReached(repository: ZyquorRepository, accountId: string, dailyPostLimit: number | null) {
  if (!dailyPostLimit) {
    return false;
  }

  const today = new Date().toISOString().slice(0, 10);
  const history = await repository.listPostHistory();
  const postsToday = history.filter((item) => item.accountId === accountId && item.postedAt.startsWith(today)).length;
  return postsToday >= dailyPostLimit;
}

async function hasRunningJobForAccount(repository: ZyquorRepository, accountId: string, currentJobId: string) {
  const jobs = await repository.listJobs();
  return jobs.some(
    (job) => job.accountId === accountId && job.id !== currentJobId && (job.status === "queued" || job.status === "running")
  );
}

async function sourcePacketIdForDraft(repository: ZyquorRepository, draftId: string) {
  const draft = await repository.getDraft(draftId);
  const sourcePacketId = draft?.candidates
    .map((candidate) => candidate.score.sourcePacketId)
    .find((value): value is string => typeof value === "string");
  return sourcePacketId ?? null;
}

async function removePostedDraftSourcePacket(repository: ZyquorRepository, draftId: string) {
  const sourcePacketId = await sourcePacketIdForDraft(repository, draftId);
  if (!sourcePacketId) {
    return null;
  }
  const packet = await repository.getSourcePacket(sourcePacketId);
  return packet ? repository.deleteSourcePacket(sourcePacketId) : null;
}

function isScheduledForFuture(job: { scheduledFor: string | null }) {
  return job.scheduledFor ? Date.parse(job.scheduledFor) > Date.now() : false;
}

function addMinutes(timestamp: string, minutes: number) {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
}

function shuffleJobs<T>(items: T[]) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
  }
  return shuffled;
}

function isPostingMode(value: unknown): value is PostingMode {
  return (
    value === "draft_only" ||
    value === "prepare_only" ||
    value === "review_required" ||
    value === "scheduled" ||
    value === "autopost"
  );
}

const STALE_RUNNING_JOB_MS = 10 * 60 * 1000;

async function recoverStaleRunningJobs(repository: ZyquorRepository, accountId: string, currentJobId: string) {
  const jobs = await repository.listJobs();
  const now = Date.now();
  const staleJobs = jobs.filter(
    (job) =>
      job.accountId === accountId &&
      job.id !== currentJobId &&
      job.status === "running" &&
      now - Date.parse(job.updatedAt) > STALE_RUNNING_JOB_MS
  );

  for (const job of staleJobs) {
    await repository.updateJobStatus(job.id, "failed");
    await repository.createAttempt({
      jobId: job.id,
      status: "failed",
      errorCode: "stale_running_job",
      errorMessage: "Recovered stale running job before starting another browser job"
    });
  }
}

function createDefaultSourceAdapters(): SourceAdapter[] {
  const crawlService = createCrawl4AiService();
  return [createAggregatedNewsAdapter({ crawlService }), createRssAdapter()];
}

function adaptersBySourceType(adapters: SourceAdapter[]) {
  return new Map(adapters.map((adapter) => [adapter.sourceType, adapter]));
}

function readSavedGenerationEnv(configPath: string | null): GenerationEnvironment {
  if (!configPath) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as {
      model?: unknown;
      provider?: unknown;
    };
    const provider = typeof parsed.provider === "string" ? parsed.provider : undefined;
    const model = typeof parsed.model === "string" ? parsed.model : undefined;

    if (!provider || !model) {
      return {};
    }

    return {
      ZYQUOR_LLM_PROVIDER: provider,
      ...(provider === "gemini" ? { ZYQUOR_GEMINI_MODEL: model } : {}),
      ...(provider === "openrouter" ? { ZYQUOR_OPENROUTER_MODEL: model } : {}),
      ...(provider === "ollama" ? { ZYQUOR_OLLAMA_MODEL: model } : {})
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function writeSavedGenerationEnv(configPath: string | null, env: GenerationEnvironment) {
  if (!configPath) {
    return;
  }

  const config = resolveGenerationProviderConfig(env);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({ provider: config.provider, model: config.model }, null, 2)}\n`,
    "utf8"
  );
}

async function postBrowserJob(repository: ZyquorRepository, options: BuildAppOptions, jobId: string) {
  prepareJobRequestSchema.parse({ jobId });

  if (!options.enableBrowserPost) {
    throw new HttpError(403, "Browser post action is disabled");
  }

  const job = await repository.getJob(jobId);
  if (!job) {
    throw new HttpError(404, "Job not found");
  }
  if (job.status !== "approved" && job.status !== "prepared" && job.status !== "failed") {
    throw new HttpError(409, `Job must be approved, prepared, or failed before posting: ${job.status}`);
  }

  const account = await repository.getAccount(job.accountId);
  const draftWithCandidates = await repository.getDraft(job.draftId);
  if (!account || !draftWithCandidates?.draft.editedText) {
    throw new HttpError(409, "Job is missing account or approved text");
  }
  if (isScheduledForFuture(job)) {
    throw new HttpError(409, `Job is scheduled for ${job.scheduledFor}`);
  }
  if (!isAccountRunnable(account)) {
    throw new HttpError(409, "Account is not enabled for browser jobs");
  }
  if (await isDailyLimitReached(repository, account.id, account.dailyPostLimit)) {
    throw new HttpError(409, "Daily post limit reached for this account");
  }
  await recoverStaleRunningJobs(repository, account.id, job.id);
  if (await hasRunningJobForAccount(repository, account.id, job.id)) {
    throw new HttpError(409, "Another browser job is already running for this account");
  }
  assertDedicatedProfileDir(account.profileDir);

  if (job.status === "approved" || job.status === "failed") {
    await repository.updateJobStatus(job.id, "queued");
    await repository.updateJobStatus(job.id, "running");
  } else {
    await repository.updateJobStatus(job.id, "running");
  }
  await repository.createAttempt({ jobId: job.id, status: "started" });

  try {
    const preparePost = options.preparePost ?? (await import("@zyquor/browser")).preparePost;
    const mediaPaths = await mediaPathsForDraft(draftWithCandidates.draft);
    const result = await preparePost({
      profileDir: resolveProfileDir(account.profileDir),
      text: draftWithCandidates.draft.editedText,
      replyToUrl: draftWithCandidates.draft.replyToUrl ?? null,
      ...(mediaPaths.length ? { mediaPaths } : {}),
      ...browserOptions(options),
      submit: true
    });
    await repository.createAttempt({ jobId: job.id, status: "post_clicked" });
    const posted = await repository.updateJobStatus(job.id, "posted");
    const history = await repository.createPostHistory({
      accountId: job.accountId,
      draftId: job.draftId,
      postedText: draftWithCandidates.draft.editedText,
      postUrl: result.postUrl
    });
    await removePostedDraftSourcePacket(repository, job.draftId);
    await repository.createAttempt({ jobId: job.id, status: "verified" });
    return { job: posted, history };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown browser error";
    const artifacts = browserArtifacts(error);
    await repository.updateJobStatus(job.id, "failed");
    await repository.createAttempt({
      jobId: job.id,
      status: "failed",
      errorCode: "browser_post_failed",
      errorMessage: message,
      screenshotPath: artifacts.screenshotPath,
      tracePath: artifacts.tracePath
    });
    throw new HttpError(500, message);
  }
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const repositoryPromise = options.repository ? Promise.resolve(options.repository) : createLocalRepository();
  const sourceAdapters = adaptersBySourceType(options.sourceAdapters ?? createDefaultSourceAdapters());
  const baseGenerationEnv = options.generationEnv ?? process.env;
  const generationConfigPath =
    options.generationConfigPath === undefined
      ? options.repository
        ? null
        : defaultGenerationConfigPath()
      : options.generationConfigPath;
  let generationEnv = {
    ...baseGenerationEnv,
    ...readSavedGenerationEnv(generationConfigPath)
  };
  let generationProvider = options.generationProvider ?? createGenerationProviderFromEnv(generationEnv);

  app.register(cors, {
    origin: true
  });

  app.setErrorHandler((caught, _request, reply) => {
    const error = asError(caught);
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        issues: error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message
        }))
      });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }

    app.log.error(error);
    if (isConflictError(error)) {
      return reply.code(409).send({ error: error.message });
    }
    if (isGenerationError(error)) {
      return reply.code(503).send({ error: error.message });
    }

    return reply.code(500).send({ error: error.message });
  });

  app.get("/health", async () => ({
    ok: true,
    generation: {
      provider: generationProvider.name,
      model: generationProvider.model
    }
  }));

  app.get("/generation", async () => ({
    generation: resolveGenerationProviderConfig(generationEnv),
    providers: GENERATION_MODEL_OPTIONS
  }));

  app.patch("/generation", async (request) => {
    const input = updateGenerationConfigRequestSchema.parse(request.body);
    const nextEnv: GenerationEnvironment = {
      ...generationEnv,
      ZYQUOR_LLM_PROVIDER: input.provider,
      ...(input.provider === "gemini" ? { ZYQUOR_GEMINI_MODEL: input.model } : {}),
      ...(input.provider === "openrouter" ? { ZYQUOR_OPENROUTER_MODEL: input.model } : {}),
      ...(input.provider === "ollama" ? { ZYQUOR_OLLAMA_MODEL: input.model } : {})
    };
    const nextProvider = options.generationProvider ?? createGenerationProviderFromEnv(nextEnv);
    generationEnv = nextEnv;
    generationProvider = nextProvider;
    writeSavedGenerationEnv(generationConfigPath, generationEnv);

    return {
      generation: resolveGenerationProviderConfig(generationEnv),
      providers: GENERATION_MODEL_OPTIONS
    };
  });

  app.get("/browser/x-session", async (request, reply) => {
    const repository = await repositoryPromise;
    const { accountId } = request.query as { accountId?: string };
    const accounts = await repository.listAccounts();
    const account = accounts.find((item) => item.id === (accountId ?? "account_personal")) ?? accounts[0];

    if (!account) {
      return reply.code(404).send({ error: "Account not found" });
    }

    assertDedicatedProfileDir(account.profileDir);
    const profileDir = resolveProfileDir(account.profileDir);

    try {
      const checkXLogin =
        options.checkXLogin ??
        (async (input: { browserChannel?: string | null; cdpUrl?: string; profileDir: string }) => {
          const browser = await import("@zyquor/browser");
          return browser.checkXLogin(input);
        });
      const result = await checkXLogin({
        profileDir,
        ...browserOptions(options)
      });

      return {
        accountId: account.id,
        cdpUrl: options.browserCdpUrl ?? null,
        enabled: options.enableBrowserPrepare === true,
        error: null,
        loggedIn: result.loggedIn,
        profileDir,
        url: result.url
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown browser session error";
      return {
        accountId: account.id,
        cdpUrl: options.browserCdpUrl ?? null,
        enabled: options.enableBrowserPrepare === true,
        error: message,
        loggedIn: false,
        profileDir,
        url: null
      };
    }
  });


  app.get("/accounts", async () => ({
    accounts: await (await repositoryPromise).listAccounts()
  }));

  app.get("/source-packets", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    return {
      packets: await (await repositoryPromise).listSourcePackets(accountId)
    };
  });

  app.delete("/source-packets", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    const repository = await repositoryPromise;
    const packets = await repository.listSourcePackets(accountId);
    const jobs = await repository.listJobs();
    const results = [];

    for (const packet of packets) {
      const draft = await repository.getDraftBySourcePacketId(packet.id);
      if (draft) {
        const draftJobs = jobs.filter((job) => job.draftId === draft.draft.id);
        const hasPostedJob = draftJobs.some((job) => job.status === "posted");
        const hasRunningJob = draftJobs.some((job) => job.status === "running" || job.status === "queued");
        if (hasRunningJob) {
          results.push({ deleted: false, draftId: draft.draft.id, packetId: packet.id, reason: "job_running" });
          continue;
        }
        if (!hasPostedJob) {
          await repository.deleteDraft(draft.draft.id);
        }
      }

      await repository.deleteSourcePacket(packet.id);
      results.push({ deleted: true, draftId: draft?.draft.id ?? null, packetId: packet.id, reason: null });
    }

    return {
      deletedCount: results.filter((result) => result.deleted).length,
      skippedCount: results.filter((result) => !result.deleted).length,
      results
    };
  });

  app.post("/source-packets", async (request, reply) => {
    const input = createSourcePacketRequestSchema.parse(request.body);
    const repository = await repositoryPromise;
    const packet = await repository.createSourcePacket({
      accountId: input.accountId,
      facts: input.facts,
      sourceType: input.sourceType,
      summary: input.summary,
      title: input.title,
      tweetType: input.tweetType,
      url: input.url ?? null
    });

    return reply.code(201).send({ packet });
  });

  app.post("/source-packets/:id/draft", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await repositoryPromise;
    const packet = await repository.getSourcePacket(id);
    if (!packet) {
      return reply.code(404).send({ error: "Source packet not found" });
    }

    const draft = await draftFromSourcePacket({
      generationProvider,
      packet,
      repository
    });

    return reply.code(201).send(draft);
  });

  app.delete("/source-packets/:id/draft", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await repositoryPromise;
    const packet = await repository.getSourcePacket(id);
    if (!packet) {
      return reply.code(404).send({ error: "Source packet not found" });
    }

    const existingDraft = await repository.getDraftBySourcePacketId(id);
    if (!existingDraft) {
      return {
        deleted: false,
        draft: null,
        packet: packet.status === "drafted" ? await repository.resetSourcePacket(id) : packet
      };
    }

    try {
      const deleted = await repository.deleteDraft(existingDraft.draft.id);
      const resetPacket = await repository.resetSourcePacket(id);
      return {
        candidates: deleted.candidates,
        deleted: true,
        draft: deleted.draft,
        packet: resetPacket
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown draft delete error";
      return reply.code(409).send({ error: message });
    }
  });

  app.get("/ingest-configs", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    return {
      configs: await (await repositoryPromise).listIngestConfigs(accountId)
    };
  });

  app.get("/ingest-sources", async () => ({
    sources: [...sourceAdapters.values()].map((adapter) => ({
      name: adapter.name,
      sourceType: adapter.sourceType
    }))
  }));

  app.post("/ingest-configs", async (request, reply) => {
    const input = createIngestConfigRequestSchema.parse(request.body);
    const repository = await repositoryPromise;
    const config = await repository.createIngestConfig({
      accountId: input.accountId,
      sourceType: input.sourceType,
      maxPacketsPerDay: input.maxPacketsPerDay,
      metadata: input.metadata,
      tweetTypeMix: input.tweetTypeMix,
      scheduleWindowStart: input.scheduleWindowStart,
      scheduleWindowEnd: input.scheduleWindowEnd,
      enabled: input.enabled
    });

    return reply.code(201).send({ config });
  });

  app.patch("/ingest-configs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = updateIngestConfigRequestSchema.parse(request.body);
    const repository = await repositoryPromise;

    try {
      return {
        config: await repository.updateIngestConfig(id, definedEntries(input))
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return reply.code(404).send({ error: "Ingest config not found" });
      }
      throw error;
    }
  });

  app.delete("/ingest-configs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await repositoryPromise;

    try {
      return { config: await repository.deleteIngestConfig(id) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return reply.code(404).send({ error: "Ingest config not found" });
      }
      throw error;
    }
  });

  app.post("/ingest-run", async (request, reply) => {
    const repository = await repositoryPromise;
    const result = await runAutomaticIngest({
      adapters: sourceAdapters,
      generationProvider,
      repository
    });

    for (const error of result.errors) {
      app.log.error(`Ingest run failed for config ${error.configId}: ${error.error}`);
    }

    return result;
  });

  app.get("/style-profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await repositoryPromise;
    const profile = await repository.getStyleProfile(id);
    if (!profile) {
      return reply.code(404).send({ error: "Style profile not found" });
    }

    return { profile };
  });

  app.patch("/style-profiles/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = updateStyleProfileRequestSchema.parse(request.body);
    const repository = await repositoryPromise;

    return {
      profile: await repository.updateStyleProfile(id, definedEntries(input))
    };
  });

  app.patch("/accounts/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = updateAccountRequestSchema.parse(request.body);
    const repository = await repositoryPromise;

    if (input.profileDir) {
      assertDedicatedProfileDir(input.profileDir);
    }

    return {
      account: await repository.updateAccount(id, definedEntries(input))
    };
  });

  app.get("/drafts/pending", async () => {
    const repository = await repositoryPromise;
    return { drafts: await repository.listPendingDrafts() };
  });

  app.post("/drafts/:id/generate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await repositoryPromise;
    const existing = await repository.getDraft(id);
    if (!existing || existing.draft.status !== "created") {
      return reply.code(404).send({ error: "Draft not found or already generated" });
    }

    const draft = existing.draft;
    const metadata = draft.metadata as Record<string, unknown>;
    const context = await accountGenerationContext(repository, draft.accountId);
    const count = metadata.yolo ? 1 : (Number(metadata.count) || 3);

    const candidates = await generationProvider.generateDraftCandidates({
      idea: draft.sourceInput,
      count,
      ...context,
      ...(metadata.tweetType ? { tweetType: metadata.tweetType as string } : {})
    });

    const updated = await repository.saveDraftCandidates(draft.id, candidates);

    if (metadata.yolo) {
      const selectedText = updated.candidates[0]?.text;
      if (selectedText) {
        const mode = metadata.autopost ? "autopost" : isPostingMode(metadata.mode) ? metadata.mode : "prepare_only";
        const approved = await repository.approveDraft({
          draftId: draft.id,
          editedText: selectedText,
          mode,
          replyToUrl: draft.replyToUrl ?? null,
          scheduledFor: (metadata.scheduleStart as string | null | undefined) ?? null
        });
        return reply.code(201).send({ ...approved, candidates: updated.candidates });
      }
    }

    return reply.code(201).send(updated);
  });

  app.post("/drafts", async (request, reply) => {
    const input = createDraftRequestSchema.parse(request.body);
    const repository = await repositoryPromise;

    const result = await repository.createDraft({
      accountId: input.accountId,
      sourceInput: input.idea,
      replyToUrl: input.replyToUrl ?? null,
      metadata: {
        yolo: input.yolo,
        autopost: input.autopost,
        count: input.count ?? 3,
        tweetType: input.tweetType
      }
    });

    return reply.code(201).send(result);
  });

  app.post("/draft-batches", async (request, reply) => {
    const input = createDraftBatchRequestSchema.parse(request.body);
    if (input.mode === "scheduled" && !input.scheduleStart) {
      return reply.code(400).send({ error: "scheduleStart is required for scheduled batch jobs" });
    }
    const repository = await repositoryPromise;
    const scheduleSpacingMinutes = input.scheduleSpacingMinutes ?? 90;
    const defaultMode = input.mode ?? (input.scheduleStart ? "scheduled" : "prepare_only");
    const mode = input.yolo && input.autopost ? "autopost" : (input.yolo ? "prepare_only" : defaultMode);
    const created = [];

    for (const [index, idea] of input.ideas.entries()) {
      const draft = await repository.createDraft({
        accountId: input.accountId,
        sourceInput: idea,
        replyToUrl: input.replyToUrl ?? null,
        metadata: {
          lane: "batch",
          yolo: input.yolo,
          autopost: input.autopost,
          mode,
          tweetType: input.tweetType,
          scheduleStart: input.scheduleStart ? addMinutes(input.scheduleStart, index * scheduleSpacingMinutes) : null
        }
      });
      created.push(draft);
    }

    return reply.code(201).send({ items: created });
  });

  app.get("/drafts/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await repositoryPromise;
    const draft = await repository.getDraft(id);

    if (!draft) {
      return reply.code(404).send({ error: "Draft not found" });
    }

    return draft;
  });

  app.post("/drafts/:id/select", async (request) => {
    const { id } = request.params as { id: string };
    const input = selectDraftCandidateRequestSchema.parse(request.body);
    const repository = await repositoryPromise;

    return repository.selectCandidate({
      draftId: id,
      candidateId: input.candidateId,
      ...(input.editedText ? { editedText: input.editedText } : {})
    });
  });

  app.post("/drafts/:id/approve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = approveDraftRequestSchema.parse(request.body);
    if (input.mode === "scheduled" && !input.scheduledFor) {
      return reply.code(400).send({ error: "scheduledFor is required for scheduled jobs" });
    }
    const repository = await repositoryPromise;
    const existing = await repository.getDraft(id);
    if (!existing) {
      return reply.code(404).send({ error: "Draft not found" });
    }

    const result = await repository.approveDraft({
      draftId: id,
      editedText: input.editedText,
      ...(input.mode ? { mode: input.mode } : {}),
      scheduledFor: input.scheduledFor ?? null,
      replyToUrl: existing.draft.replyToUrl ?? null
    });

    return reply.code(201).send(result);
  });

  app.get("/jobs", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    const jobs = await (await repositoryPromise).listJobs();
    return {
      jobs: accountId ? jobs.filter((job) => job.accountId === accountId) : jobs
    };
  });

  app.get("/history", async () => ({
    history: await (await repositoryPromise).listPostHistory()
  }));

  app.get("/jobs/:id/attempts", async (request) => {
    const { id } = request.params as { id: string };
    const repository = await repositoryPromise;
    return {
      attempts: await repository.listAttempts(id)
    };
  });

  app.post("/jobs/post-ready", async (request) => {
    const { accountId } = request.body as { accountId?: string };
    if (!accountId) {
      throw new HttpError(400, "accountId is required");
    }
    const repository = await repositoryPromise;
    const now = Date.now();
    const readyJobs = (await repository.listJobs())
      .filter((job) => {
        if (job.accountId !== accountId) {
          return false;
        }
        if (job.status !== "approved" && job.status !== "prepared" && job.status !== "failed") {
          return false;
        }
        if (!job.scheduledFor) {
          return true;
        }
        return Date.parse(job.scheduledFor) <= now;
      })
      .sort((a, b) => {
        const timeA = Date.parse(a.scheduledFor || a.createdAt);
        const timeB = Date.parse(b.scheduledFor || b.createdAt);
        return timeA - timeB;
      });
    const results = [];

    for (const job of readyJobs) {
      try {
        const result = await postBrowserJob(repository, options, job.id);
        results.push({
          jobId: job.id,
          status: "posted",
          job: result.job,
          history: result.history,
          error: null
        });
      } catch (error) {
        results.push({
          jobId: job.id,
          status: "failed",
          job: await repository.getJob(job.id),
          history: null,
          error: error instanceof Error ? error.message : "Unknown post error"
        });
      }
    }

    return {
      posted: results.filter((result) => result.status === "posted").length,
      failed: results.filter((result) => result.status === "failed").length,
      total: results.length,
      results
    };
  });

  app.delete("/jobs", async () => {
    const repository = await repositoryPromise;
    const jobs = await repository.listJobs();
    const deleted = [];

    for (const job of jobs) {
      if (job.status !== "running") {
        await repository.deleteJob(job.id);
        deleted.push(job.id);
      }
    }

    return { deletedCount: deleted.length, ids: deleted };
  });

  app.delete("/jobs/cleanup", async () => {
    const repository = await repositoryPromise;
    const jobs = await repository.listJobs();
    const toDelete = jobs.filter((job) => job.status === "posted" || job.status === "failed");
    const deleted = [];

    for (const job of toDelete) {
      await repository.deleteJob(job.id);
      deleted.push(job.id);
    }

    return { deletedCount: deleted.length, ids: deleted };
  });

  app.delete("/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await repositoryPromise;
    const job = await repository.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: "Job not found" });
    }
    if (job.status === "running") {
      return reply.code(409).send({ error: "Cannot delete a running job" });
    }

    return { job: await repository.deleteJob(id) };
  });

  app.post("/jobs/:id/prepare", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await repositoryPromise;
    prepareJobRequestSchema.parse({ jobId: id });

    const job = await repository.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: "Job not found" });
    }

    const account = await repository.getAccount(job.accountId);
    const draftWithCandidates = await repository.getDraft(job.draftId);
    if (!account || !draftWithCandidates?.draft.editedText) {
      return reply.code(409).send({ error: "Job is missing account or approved text" });
    }
    if (isScheduledForFuture(job)) {
      return reply.code(409).send({ error: `Job is scheduled for ${job.scheduledFor}` });
    }
    if (!isAccountRunnable(account)) {
      return reply.code(409).send({ error: "Account is not enabled for browser jobs" });
    }
    await recoverStaleRunningJobs(repository, account.id, job.id);
    if (await hasRunningJobForAccount(repository, account.id, job.id)) {
      return reply.code(409).send({ error: "Another browser job is already running for this account" });
    }
    assertDedicatedProfileDir(account.profileDir);

    await repository.updateJobStatus(job.id, "queued");
    await repository.updateJobStatus(job.id, "running");
    await repository.createAttempt({ jobId: job.id, status: "started" });

    if (!options.enableBrowserPrepare) {
      const prepared = await repository.updateJobStatus(job.id, "prepared");
      await repository.createAttempt({ jobId: job.id, status: "text_inserted" });
      return { job: prepared, dryRun: true };
    }

    try {
      const preparePost = options.preparePost ?? (await import("@zyquor/browser")).preparePost;
      const mediaPaths = await mediaPathsForDraft(draftWithCandidates.draft);
      await preparePost({
        profileDir: resolveProfileDir(account.profileDir),
        text: draftWithCandidates.draft.editedText,
        replyToUrl: draftWithCandidates.draft.replyToUrl ?? null,
        ...(mediaPaths.length ? { mediaPaths } : {}),
        ...browserOptions(options),
        closeAfterPrepare: options.closeAfterPrepare ?? true
      });
      const prepared = await repository.updateJobStatus(job.id, "prepared");
      await repository.createAttempt({ jobId: job.id, status: "text_inserted" });
      return { job: prepared, dryRun: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown browser error";
      const artifacts = browserArtifacts(error);
      await repository.updateJobStatus(job.id, "failed");
      await repository.createAttempt({
        jobId: job.id,
        status: "failed",
        errorCode: "browser_prepare_failed",
        errorMessage: message,
        screenshotPath: artifacts.screenshotPath,
        tracePath: artifacts.tracePath
      });
      return reply.code(500).send({ error: message });
    }
  });

  app.post("/jobs/:id/post", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await repositoryPromise;

    try {
      return await postBrowserJob(repository, options, id);
    } catch (error) {
      const httpError = asHttpError(error);
      return reply.code(httpError?.statusCode ?? 500).send({
        error: error instanceof Error ? error.message : "Unknown browser error"
      });
    }
  });

  return app;
}
