import { describe, expect, it } from "vitest";
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureFirstRun } from "./firstrun.js";

describe("ensureFirstRun", () => {
  it("creates data/artifacts and profiles/personal-main on an empty dir", () => {
    const root = resolve(tmpdir(), `zyq-firstrun-test-${randomUUID()}`);
    mkdirSync(root, { recursive: true });

    ensureFirstRun(root);

    expect(existsSync(resolve(root, "data", "artifacts"))).toBe(true);
    expect(existsSync(resolve(root, "profiles", "personal-main"))).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it("is idempotent — repeated calls do not throw", () => {
    const root = resolve(tmpdir(), `zyq-firstrun-test-${randomUUID()}`);
    mkdirSync(root, { recursive: true });

    ensureFirstRun(root);
    ensureFirstRun(root);
    ensureFirstRun(root);

    expect(existsSync(resolve(root, "data", "artifacts"))).toBe(true);
    expect(existsSync(resolve(root, "profiles", "personal-main"))).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it("does not fail when dirs already exist from a prior call", () => {
    const root = resolve(tmpdir(), `zyq-firstrun-test-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, "data", "artifacts"), { recursive: true });
    mkdirSync(join(root, "profiles", "personal-main"), { recursive: true });

    ensureFirstRun(root);

    expect(existsSync(resolve(root, "data", "artifacts"))).toBe(true);
    expect(existsSync(resolve(root, "profiles", "personal-main"))).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });
});
