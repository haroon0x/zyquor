import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OPENCODE_MODEL, DEFAULT_OPENCODE_VARIANT, safeOpencodeModel, safeOpencodeVariant } from "../config.js";
import { generateDraftCandidates } from "../refine.js";
import type { DraftGenerationProvider } from "../types.js";
import { providerProcessEnv } from "./cli-env.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1_000_000;

function runOpencode(input: {
  command: string;
  model: string;
  variant: string;
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  // opencode v2.x: the reasoning variant is part of --model (provider/model#variant).
  // The legacy separate --variant/--pure flags are no longer recognized.
  const child = spawn(input.command, [
    "run",
    "-m",
    input.variant ? `${input.model}#${input.variant}` : input.model
  ], {
    cwd: tmpdir(),
    env: providerProcessEnv(),
    shell: platform() === "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;

  const finish = (error?: Error, value?: string) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    if (error) reject(error);
    else resolve(value ?? "");
  };
  const append = (target: Buffer[], chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      child.kill();
      finish(new Error("Opencode generation exceeded the output limit"));
      return;
    }
    target.push(chunk);
  };
  const timeout = setTimeout(() => {
    child.kill();
    finish(new Error(`Opencode generation timed out after ${input.timeoutMs}ms`));
  }, input.timeoutMs);

  child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
  child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
  child.on("error", (error: NodeJS.ErrnoException) => {
    const message = error.code === "ENOENT"
      ? `Opencode CLI was not found at "${input.command}". Install opencode (https://opencode.ai) and run opencode auth.`
      : `Opencode failed to start: ${error.message}`;
    finish(new Error(message));
  });
  child.on("close", (code) => {
    const output = Buffer.concat(stdout).toString("utf8").trim();
    // Raw request/response audit hook: ZYQUOR_LLM_DEBUG=1 drops the exact
    // prompt and raw model stdout next to the other artifacts. Best-effort;
    // captions never fail the generation itself.
    if (process.env.ZYQUOR_LLM_DEBUG === "1") {
      try {
        const dir = join(process.cwd(), "data", "artifacts");
        mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        writeFileSync(join(dir, `llm-input-${stamp}.txt`), input.prompt);
        writeFileSync(join(dir, `llm-output-${stamp}.txt`), output);
      } catch {
        // Debug capture is best-effort only.
      }
    }
    if (code === 0) {
      finish(undefined, output);
      return;
    }
    const details = Buffer.concat(stderr).toString("utf8").trim() || output;
    finish(new Error(`Opencode generation failed with exit code ${code}: ${details.slice(0, 1000)}`));
  });
  child.stdin.on("error", () => undefined);
  child.stdin.end(input.prompt);

  return promise;
}

export function createOpencodeGenerationProvider(options: {
  command?: string;
  model?: string;
  variant?: string;
  timeoutMs?: number;
  revise?: boolean;
} = {}): DraftGenerationProvider {
  const command = options.command?.trim() || "opencode";
  const model = safeOpencodeModel(options.model?.trim());
  const variant = safeOpencodeVariant(options.variant?.trim());

  return {
    name: "opencode",
    model,
    async generateDraftCandidates(input) {
      const run = (prompt: string) => runOpencode({
        command,
        model,
        variant,
        prompt,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      });
      return generateDraftCandidates({
        generationInput: input,
        model,
        providerName: "opencode",
        runPrompt: run,
        revise: options.revise
      });
    }
  };
}