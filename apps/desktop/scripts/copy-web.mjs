import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(import.meta.dirname, "../../web/dist");
const destination = resolve(import.meta.dirname, "../dist/web");

try {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
  console.log(`Copied web UI from ${source} to ${destination}`);
} catch (error) {
  if (error?.code === "ENOENT") {
    console.warn(`Web UI not built; skipping copy from ${source}`);
  } else {
    throw error;
  }
}
