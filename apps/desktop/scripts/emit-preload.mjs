import { copyFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const from = join(distDir, "preload.js");
const to = join(distDir, "preload.cjs");
if (!existsSync(from)) throw new Error("dist/preload.js missing — run tsc first");
copyFileSync(from, to);
unlinkSync(from);
