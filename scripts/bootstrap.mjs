import { mkdirSync } from "node:fs";

for (const dir of ["data/artifacts", "profiles/personal-main"]) {
  mkdirSync(dir, { recursive: true });
  console.log(`created ${dir}`);
}
