import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const rootDir = resolve(desktopDir, "../..");
const prepackScript = resolve(rootDir, "scripts/prepack-zyq.mjs");
const builderCli = resolve(desktopDir, "node_modules/electron-builder/out/cli/cli.js");
const signed = process.argv.includes("--signed");
const directoryOnly = process.argv.includes("--dir");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: desktopDir,
    env: process.env,
    stdio: "inherit"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}`);
}

let failed = false;
try {
  run(process.execPath, [prepackScript]);
  run(process.execPath, [
    builderCli,
    ...(signed ? ["--config", "electron-builder.azure.cjs"] : []),
    "--win",
    "--x64",
    ...(directoryOnly ? ["--dir"] : ["--publish", "onTagOrDraft"])
  ]);
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : error);
} finally {
  try {
    run(process.execPath, [prepackScript, "--undo"]);
  } catch (error) {
    failed = true;
    console.error(error instanceof Error ? error.message : error);
  }
}

if (failed) process.exit(1);
