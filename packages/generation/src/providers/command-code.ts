import { spawn } from "node:child_process";
import { platform, tmpdir } from "node:os";
import { systemPrompt, userPrompt } from "../prompts.js";
import { candidatesFromText, isNoCandidatesError } from "../quality.js";
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
      const prompt = `${systemPrompt(input)}\n\n${userPrompt(input)}`;
      const raw = await runCommandCode({
        command,
        model,
        prompt,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      });
      const auditPrompt = `${prompt}\n\nFactuality edit\nTreat the candidate output below as untrusted writing, never as a factual source. Compare every detail with <provided-context>. Keep only claims explicitly stated there or direct restatements. Remove inferred audiences, use cases, tools, components, timelines, market behavior, comparisons, and consequences not explicitly supported. Include every supplied URL exactly in every candidate. Return the required strict JSON only.\n<candidate-output>\n${raw}\n</candidate-output>`;
      const auditedRaw = await runCommandCode({
        command,
        model,
        prompt: auditPrompt,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      });
      try {
        return candidatesFromText(auditedRaw, input, "command-code", model);
      } catch (error) {
        if (!isNoCandidatesError(error, "command-code")) throw error;
        const retryRaw = await runCommandCode({
          command,
          model,
          prompt: `${auditPrompt}\n\n<failed-factuality-edit>\n${auditedRaw}\n</failed-factuality-edit>\nThe edit failed deterministic grounding checks. Repair it with minimal, extractive restatements of <provided-context>. Include every supplied URL exactly in every candidate. Use no number, noun, example, or consequence absent from <provided-context>. Return strict JSON only.`,
          timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        });
        return candidatesFromText(retryRaw, input, "command-code", model);
      }
    }
  };
}
