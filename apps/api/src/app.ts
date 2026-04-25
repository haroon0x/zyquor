import cors from "@fastify/cors";
import { assertDedicatedProfileDir, isAccountRunnable } from "@zyquor/accounts";
import {
  approveDraftRequestSchema,
  createDraftRequestSchema,
  prepareJobRequestSchema,
  selectDraftCandidateRequestSchema,
  updateAccountRequestSchema
} from "@zyquor/core";
import {
  createGenerationProviderFromEnv,
  resolveGenerationProviderConfig,
  type DraftGenerationProvider,
  type GenerationEnvironment
} from "@zyquor/generation";
import { createLocalRepository, type ZyquorRepository } from "@zyquor/storage";
import Fastify from "fastify";
import { isAbsolute, resolve } from "node:path";
import { ZodError } from "zod";

export interface BuildAppOptions {
  repository?: ZyquorRepository;
  generationProvider?: DraftGenerationProvider;
  generationEnv?: GenerationEnvironment;
  enableBrowserPrepare?: boolean;
  enableBrowserPost?: boolean;
  browserActionDelayMs?: number;
  browserChannel?: string | null;
  browserCdpUrl?: string;
  browserTypingDelayMs?: number;
  closeAfterPrepare?: boolean;
}

function browserArtifacts(error: unknown) {
  const maybeError = error as { screenshotPath?: unknown; tracePath?: unknown };
  return {
    screenshotPath: typeof maybeError.screenshotPath === "string" ? maybeError.screenshotPath : null,
    tracePath: typeof maybeError.tracePath === "string" ? maybeError.tracePath : null
  };
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
    error.message.includes("ZYQUOR_GEMINI_API_KEY")
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

function resolveProfileDir(profileDir: string) {
  return isAbsolute(profileDir) ? profileDir : resolve(workspaceRoot(), profileDir);
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

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true });
  const repositoryPromise = options.repository ? Promise.resolve(options.repository) : createLocalRepository();
  const generationEnv = options.generationEnv ?? process.env;
  const generationProvider = options.generationProvider ?? createGenerationProviderFromEnv(generationEnv);

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
    generation: resolveGenerationProviderConfig(generationEnv)
  }));

  app.get("/accounts", async () => ({
    accounts: await (await repositoryPromise).listAccounts()
  }));

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

  app.post("/drafts", async (request, reply) => {
    const input = createDraftRequestSchema.parse(request.body);
    const repository = await repositoryPromise;
    const candidates = await generationProvider.generateDraftCandidates({
      idea: input.idea,
      ...(input.count ? { count: input.count } : {})
    });
    const result = await repository.createDraft({
      accountId: input.accountId,
      sourceInput: input.idea,
      candidates
    });

    return reply.code(201).send(result);
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
    const repository = await repositoryPromise;
    const result = await repository.approveDraft({ draftId: id, editedText: input.editedText });

    return reply.code(201).send(result);
  });

  app.get("/jobs", async () => ({
    jobs: await (await repositoryPromise).listJobs()
  }));

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
    if (!isAccountRunnable(account)) {
      return reply.code(409).send({ error: "Account is not enabled for browser jobs" });
    }
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
      const { preparePost } = await import("@zyquor/browser");
      await preparePost({
        profileDir: resolveProfileDir(account.profileDir),
        text: draftWithCandidates.draft.editedText,
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
    prepareJobRequestSchema.parse({ jobId: id });

    if (!options.enableBrowserPost) {
      return reply.code(403).send({ error: "Browser post action is disabled" });
    }

    const job = await repository.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: "Job not found" });
    }
    if (job.status !== "approved" && job.status !== "prepared") {
      return reply.code(409).send({ error: `Job must be approved or prepared before posting: ${job.status}` });
    }

    const account = await repository.getAccount(job.accountId);
    const draftWithCandidates = await repository.getDraft(job.draftId);
    if (!account || !draftWithCandidates?.draft.editedText) {
      return reply.code(409).send({ error: "Job is missing account or approved text" });
    }
    if (!isAccountRunnable(account)) {
      return reply.code(409).send({ error: "Account is not enabled for browser jobs" });
    }
    if (await isDailyLimitReached(repository, account.id, account.dailyPostLimit)) {
      return reply.code(409).send({ error: "Daily post limit reached for this account" });
    }
    if (await hasRunningJobForAccount(repository, account.id, job.id)) {
      return reply.code(409).send({ error: "Another browser job is already running for this account" });
    }
    assertDedicatedProfileDir(account.profileDir);

    if (job.status === "approved") {
      await repository.updateJobStatus(job.id, "queued");
      await repository.updateJobStatus(job.id, "running");
    } else {
      await repository.updateJobStatus(job.id, "running");
    }
    await repository.createAttempt({ jobId: job.id, status: "started" });

    try {
      const { preparePost } = await import("@zyquor/browser");
      const result = await preparePost({
        profileDir: resolveProfileDir(account.profileDir),
        text: draftWithCandidates.draft.editedText,
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
      return reply.code(500).send({ error: message });
    }
  });

  return app;
}
