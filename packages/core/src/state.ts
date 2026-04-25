import type { DraftStatus, PostJobStatus } from "./index.js";

const draftTransitions: Record<DraftStatus, readonly DraftStatus[]> = {
  created: ["generated", "archived"],
  generated: ["selected", "archived"],
  selected: ["approved", "archived"],
  approved: ["archived"],
  archived: []
};

const postJobTransitions: Record<PostJobStatus, readonly PostJobStatus[]> = {
  created: ["approved", "cancelled"],
  approved: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["prepared", "posted", "failed"],
  prepared: ["running", "posted", "failed", "cancelled"],
  posted: [],
  failed: ["queued", "cancelled"],
  cancelled: []
};

export function canTransitionDraft(from: DraftStatus, to: DraftStatus) {
  return draftTransitions[from].includes(to);
}

export function canTransitionPostJob(from: PostJobStatus, to: PostJobStatus) {
  return postJobTransitions[from].includes(to);
}
