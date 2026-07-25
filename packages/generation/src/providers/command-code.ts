import { spawn } from "node:child_process";
import { platform, tmpdir } from "node:os";
import { generateWithQualityLoop } from "../refine.js";
import type { DraftGenerationProvider } from "../types.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 1_000_000;

function runCommandCode(input: {
  command: string;
  model: string;
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, [
      "--skip-onboarding",
      "--permission-mode",
      "plan",
      "--model",
      input.model,
      "--print"
    ], {
      cwd: tmpdir(),
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
        finish(new Error("Command Code generation exceeded the output limit"));
        return;
      }
      target.push(chunk);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`Command Code generation timed out after ${input.timeoutMs}ms`));
    }, input.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      const message = error.code === "ENOENT"
        ? `Command Code CLI was not found at "${input.command}". Install it and run command-code login.`
        : `Command Code failed to start: ${error.message}`;
      finish(new Error(message));
    });
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      if (code === 0) {
        finish(undefined, output);
        return;
      }
      const details = Buffer.concat(stderr).toString("utf8").trim() || output;
      finish(new Error(`Command Code generation failed with exit code ${code}: ${details.slice(0, 1000)}`));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input.prompt);
  });
}

export function createCommandCodeGenerationProvider(options: {
  command?: string;
  model: string;
  timeoutMs?: number;
}): DraftGenerationProvider {
  const command = options.command?.trim() || "command-code";
  const model = options.model;

  return {
    name: "command-code",
    model,
    async generateDraftCandidates(input) {
      const run = (prompt: string) => runCommandCode({
        command,
        model,
        prompt,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      });
      return generateWithQualityLoop({
        generationInput: input,
        model,
        providerName: "command-code",
        runPrompt: run
      });
    }
  };
}
