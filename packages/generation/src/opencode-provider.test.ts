import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createOpencodeGenerationProvider } from "./index.js";

function fakeChild(info: { stdout: string; stderr: string; exitCode: number }) {
  const listeners: Record<string, Array<(value: unknown) => void>> = {};
  const on = (event: string, listener: (value: unknown) => void) => {
    listeners[event] = listeners[event] ?? [];
    listeners[event]!.push(listener);
  };
  const emit = (event: string, value: unknown) => {
    for (const listener of listeners[event] ?? []) listener(value);
  };
  emit("spawn", null);
  queueMicrotask(() => {
    emit("stdout:data", Buffer.from(info.stdout));
    emit("stderr:data", Buffer.from(info.stderr));
    emit("close", info.exitCode);
  });
  const child = {
    on,
    stdout: {
      on: (event: string, listener: (value: unknown) => void) => {
        listeners[`stdout:${event}`] = listeners[`stdout:${event}`] ?? [];
        listeners[`stdout:${event}`]!.push(listener);
      }
    },
    stderr: {
      on: (event: string, listener: (value: unknown) => void) => {
        listeners[`stderr:${event}`] = listeners[`stderr:${event}`] ?? [];
        listeners[`stderr:${event}`]!.push(listener);
      }
    },
    kill: () => undefined,
    unref: () => undefined,
    stdin: { end: () => undefined, on: () => undefined }
  };
  return child as unknown as ChildProcess;
}

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe("opencode provider ladder contract", () => {
  const capError = "Error: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.\n";
  const fundsError = "Error: Insufficient account funds\n";
  const candidatesJson = '{"candidates":[{"text":"Queue drains in batches, so tail latency tracks the batch boundary, not the model."}]}\n';

  it("walks glm free, then glm paid, then deepseek when the free tag is capped", async () => {
    const models : string[] = [];
    vi.mocked(spawn).mockImplementation(((command: string, args: unknown[]) => {
      models.push((args as string[]).find((a) => String(a).startsWith("opencode")) ?? "");
      const run = models.length;
      if (run === 1) return fakeChild({ stdout: "", stderr: capError, exitCode: 1 });
      if (run === 2) return fakeChild({ stdout: "", stderr: fundsError, exitCode: 1 });
      return fakeChild({ stdout: candidatesJson, stderr: "", exitCode: 0 });
    }) as never);
    const provider = createOpencodeGenerationProvider({ command: "opencode", model: "opencode/glm-5.3-flash-free" });
    const candidates = await provider.generateDraftCandidates({
      idea: "tail latency under batched queues",
      tweetType: "opinion",
      count: 1
    });
    expect(candidates.length).toBe(1);
    expect(models).toEqual([
      "opencode/glm-5.3-flash-free#high",
      "opencode-go/glm-5.3-flash#high",
      "opencode/deepseek-v4.1-flash#high"
    ]);
  });

  it("never rotates on transient network drops", async () => {
    let calls = 0;
    vi.mocked(spawn).mockImplementation((() => {
      calls += 1;
      return fakeChild({ stdout: "", stderr: "Error: Connection lost while reading the response: ECONNRESET\n", exitCode: 1 });
    }) as never);
    const provider = createOpencodeGenerationProvider({ command: "opencode", model: "opencode/glm-5.3-flash-free" });
    await expect(
      provider.generateDraftCandidates({ idea: "tail latency under batched queues", tweetType: "opinion", count: 1 })
    ).rejects.toThrow(/exit code 1/);
    expect(calls).toBe(1);
  });

  it("surfaces the last ladder error when every step is capped", async () => {
    let calls = 0;
    vi.mocked(spawn).mockImplementation((() => {
      calls += 1;
      return fakeChild({ stdout: "", stderr: capError, exitCode: 1 });
    }) as never);
    const provider = createOpencodeGenerationProvider({ command: "opencode", model: "opencode/glm-5.3-flash-free" });
    await expect(
      provider.generateDraftCandidates({ idea: "tail latency under batched queues", tweetType: "opinion", count: 1 })
    ).rejects.toThrow(/exit code 1/);
    expect(calls).toBe(3);
  });

  it("accepts a complete candidates JSON when the CLI exits 1 after streaming the answer", async () => {
    const stdout = '{"candidates":[{"text":"Queue drains in batches, so tail latency tracks the batch boundary, not the model."}]}\n';
    const stderr = "Error: Connection lost while reading the response: ECONNRESET\n";
    vi.mocked(spawn).mockImplementation(() => fakeChild({ stdout, stderr, exitCode: 1 }));
    const provider = createOpencodeGenerationProvider({ command: "opencode" });
    const candidates = await provider.generateDraftCandidates({
      idea: "tail latency under batched queues",
      tweetType: "opinion",
      count: 1
    });
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.text).toContain("tail latency");
  });

  it("rejects clean instead of crashing when stdout is truncated mid JSON", async () => {
    const stdout = '{"candidates":[{"text":"The pg_upgrade refusal only covers upgrades. A cluster still';
    const stderr = "Error: Connection lost while reading the response: ECONNRESET\n";
    vi.mocked(spawn).mockImplementation(() => fakeChild({ stdout, stderr, exitCode: 1 }));
    const provider = createOpencodeGenerationProvider({ command: "opencode" });
    await expect(
      provider.generateDraftCandidates({
        idea: "tail latency under batched queues",
        tweetType: "opinion",
        count: 1
      })
    ).rejects.toThrow(/exit code 1/);
  });

  it("fails clean for a stdout with no candidates payload", async () => {
    const stdout = "the model was mid-turn when the connection dropped";
    const stderr = "Error: Connection lost while reading the response: ECONNRESET\n";
    vi.mocked(spawn).mockImplementation(() => fakeChild({ stdout, stderr, exitCode: 1 }));
    const provider = createOpencodeGenerationProvider({ command: "opencode" });
    await expect(
      provider.generateDraftCandidates({
        idea: "tail latency under batched queues",
        tweetType: "opinion",
        count: 1
      })
    ).rejects.toThrow(/exit code 1/);
  });
});
