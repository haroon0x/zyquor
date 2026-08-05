import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CODEX_MODEL, safeCodexModel } from "../config.js";
import { generateDraftCandidates } from "../refine.js";
import type { DraftGenerationProvider } from "../types.js";
import { providerProcessEnv } from "./cli-env.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 1_000_000;

async function runCodex(input: {
  command: string;
  model: string;
  prompt: string;
  timeoutMs: number;
}): Promise<string> {
  const outputPath = join(tmpdir(), `codex-${randomUUID()}.txt`);
  const args = [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--color",
    "never",
    "-c",
    "model_reasoning_effort=high",
    "--model",
    input.model,
    "-o",
    outputPath
  ];
  args.push("-");

  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(input.command, args, {
        cwd: tmpdir(),
        env: providerProcessEnv(),
        shell: platform() === "win32",
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true
      });
      const stderr: Buffer[] = [];
      let stderrBytes = 0;
      let settled = false;

      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value ?? "");
      };

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
      });
      const timeout = setTimeout(() => {
        child.kill();
        finish(new Error(`Codex generation timed out after ${input.timeoutMs}ms`));
      }, input.timeoutMs);

      child.on("error", (error: NodeJS.ErrnoException) => {
        const message = error.code === "ENOENT"
          ? `Codex CLI was not found at "${input.command}". Install Codex CLI and run codex login.`
          : `Codex failed to start: ${error.message}`;
        finish(new Error(message));
      });
      child.on("close", async (code) => {
        if (code === 0) {
          try {
            const info = await stat(outputPath);
            if (info.size > MAX_OUTPUT_BYTES) {
              finish(new Error("Codex generation exceeded the output limit"));
              return;
            }
            const output = (await readFile(outputPath, "utf8")).trim();
            if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
              finish(new Error("Codex generation exceeded the output limit"));
              return;
            }
            finish(undefined, output);
          } catch (error) {
            finish(new Error(`Codex generation returned no final response: ${error instanceof Error ? error.message : String(error)}`));
          }
          return;
        }
        const details = Buffer.concat(stderr).toString("utf8").trim();
        finish(new Error(`Codex generation failed with exit code ${code}: ${details.slice(0, 1000)}`));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(input.prompt);
    });
  } finally {
    await unlink(outputPath).catch(() => undefined);
  }
}

export function createCodexGenerationProvider(options: {
  command?: string;
  model?: string;
  timeoutMs?: number;
} = {}): DraftGenerationProvider {
  const command = options.command?.trim() || "codex";
  const model = safeCodexModel(options.model?.trim());

  return {
    name: "codex",
    model,
    async generateDraftCandidates(input) {
      const run = (prompt: string) => runCodex({
        command,
        model,
        prompt,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      });
      return generateDraftCandidates({
        generationInput: input,
        model,
        providerName: "codex",
        runPrompt: run
      });
    }
  };
}
