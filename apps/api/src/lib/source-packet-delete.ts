import type { ZyquorRepository } from "@zyquor/storage";
import { HttpError } from "./errors.js";

export async function deleteSourcePacketCascade(repository: ZyquorRepository, packetId: string) {
  const packet = await repository.getSourcePacket(packetId);
  if (!packet) {
    throw new HttpError(404, "Source packet not found");
  }

  const draft = await repository.getDraftBySourcePacketId(packet.id);
  if (draft) {
    const [jobs, history] = await Promise.all([repository.listJobs(), repository.listPostHistory()]);
    const draftJobs = jobs.filter((job) => job.draftId === draft.draft.id);
    const hasRunningJob = draftJobs.some((job) => job.status === "running");
    const hasPostedJob = draftJobs.some((job) => job.status === "posted");
    const hasPostHistory = history.some((item) => item.draftId === draft.draft.id);
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
