import type { PostingMode } from "@zyquor/core";

export function isPostingMode(value: unknown): value is PostingMode {
  return (
    value === "draft_only" ||
    value === "prepare_only" ||
    value === "review_required" ||
    value === "scheduled" ||
    value === "autopost"
  );
}
