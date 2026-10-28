import type { ZyquorRepository } from "@zyquor/storage";
import { HttpError } from "./errors.js";

export async function deleteSourcePacketCascade(repository: ZyquorRepository, packetId: string) {
  const packet = await repository.getSourcePacket(packetId);
  if (!packet) {
    throw new HttpError(404, "Source packet not found");
  }

  const draft = await repository.getDraftBySourcePacketId(packet.id);
  if (draft) {
    // Indexed per-draft lookups instead of loading the full job and history tables.
    const [draftJobs, historyCount] = await Promise.all([
      repository.listJobsByDraftId(draft.draft.id),
      repository.countPostHistoryByDraftId(draft.draft.id)
    ]);
    const hasRunningJob = draftJobs.some((job) => job.status === "running");
    const hasPostedJob = draftJobs.some((job) => job.status === "posted");
    const hasPostHistory = historyCount > 0;
    if (hasRunningJob) {
      throw new HttpError(409, "Cannot delete source with a running job");
    }
    if (!hasPostedJob && !hasPostHistory) {
      await repository.deleteDraft(draft.draft.id);
    }
  }

  return {
    draftId: draft?.draft.id ?? null,
    packet: await repository.deleteSourcePacket(packet.id)
  };
}
