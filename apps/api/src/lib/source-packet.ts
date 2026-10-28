import { normalizePostText, hashPostText, type ZyquorRepository } from "@zyquor/storage";

export async function sourcePacketIdForDraft(repository: ZyquorRepository, draftId: string) {
  const draft = await repository.getDraft(draftId);
  const metadataSourcePacketId = draft?.draft.metadata.sourcePacketId;
  if (typeof metadataSourcePacketId === "string") {
    return metadataSourcePacketId;
  }

  const sourcePacketId = draft?.candidates
    .map((candidate) => candidate.score.sourcePacketId)
    .find((value): value is string => typeof value === "string");
  return sourcePacketId ?? null;
}

export async function postedSourcePacketCountForAccount(repository: ZyquorRepository, accountId: string, draftId: string) {
  const sourcePacketId = await sourcePacketIdForDraft(repository, draftId);
  if (!sourcePacketId) {
    return 0;
  }
  // Indexed count instead of loading and scanning all history rows.
  return repository.countPostHistoryBySourcePacket(accountId, sourcePacketId);
}

export async function hasPostedTextForAccount(repository: ZyquorRepository, accountId: string, text: string) {
  // Indexed by post_history.text_hash with a JS fallback for legacy rows.
  return repository.hasPostHistoryTextHash(accountId, hashPostText(text), normalizePostText(text));
}

export async function hasRunningJobForAccount(repository: ZyquorRepository, accountId: string, currentJobId: string) {
  const jobs = await repository.listJobs();
  return jobs.some(
    (job) => job.accountId === accountId && job.id !== currentJobId && (job.status === "queued" || job.status === "running")
  );
}
