import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveFeedbackDir(feedbackDir?: string): string {
  return resolve(feedbackDir ?? join(process.cwd(), "feedback"));
}

export function appendNotebookEntry(input: {
  dir: string;
  heading: string;
  lines: string[];
}): { path: string } {
  mkdirSync(input.dir, { recursive: true });
  const path = join(input.dir, "notebook.md");
  const body = [
    `## ${input.heading}`,
    ...input.lines,
    ""
  ].join("\n");
  appendFileSync(path, `${body}\n`, "utf8");
  return { path };
}