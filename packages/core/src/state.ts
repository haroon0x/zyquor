import type { DraftStatus, PostJobStatus } from "./index.js";

const draftTransitions: Record<DraftStatus, readonly DraftStatus[]> = {
  created: ["generated", "approved", "archived"],
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
  // "approved" re-arms a verified-failed job for the verify-then-retry path;
  // the transition is only taken after the thread scan proves the reply
  // never reached X. "posted" retroactively marks the opposite case: the scan
  // found the reply on X, so the failure was cosmetic.
  failed: ["queued", "approved", "posted", "cancelled"],
  cancelled: []
};

export function canTransitionDraft(from: DraftStatus, to: DraftStatus) {
  return draftTransitions[from].includes(to);
}

export function canTransitionPostJob(from: PostJobStatus, to: PostJobStatus) {
  return postJobTransitions[from].includes(to);
}
