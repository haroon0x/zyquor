import { normalizePostText, type ZyquorRepository } from "@zyquor/storage";

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
  const history = await repository.listPostHistory();
  return history.filter((item) => item.accountId === accountId && item.sourcePacketId === sourcePacketId).length;
}

export async function hasPostedTextForAccount(repository: ZyquorRepository, accountId: string, text: string) {
  const normalized = normalizePostText(text);
  const history = await repository.listPostHistory();
  return history.some((item) => item.accountId === accountId && normalizePostText(item.postedText) === normalized);
}

export async function hasRunningJobForAccount(repository: ZyquorRepository, accountId: string, currentJobId: string) {
  const jobs = await repository.listJobs();
  return jobs.some(
    (job) => job.accountId === accountId && job.id !== currentJobId && (job.status === "queued" || job.status === "running")
  );
}
