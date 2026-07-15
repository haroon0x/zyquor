import { resolveDataRoot } from "@zyquor/core";
import { ensureFirstRun } from "@zyquor/storage";

const dataRoot = resolveDataRoot();
ensureFirstRun(dataRoot);

console.log(`created data/artifacts`);
console.log(`created profiles/personal-main`);
