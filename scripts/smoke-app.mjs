import { buildApp } from "../apps/api/dist/app.js";
import { createMemoryRepository } from "../packages/storage/dist/index.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const app = buildApp({
  generationEnv: { ZYQUOR_LLM_PROVIDER: "mock" },
  repository: createMemoryRepository({
    now: () => new Date().toISOString()
  })
});

try {
  const health = await app.inject({ method: "GET", url: "/health" });
  assert(health.statusCode === 200, "health should return 200");

  const created = await app.inject({
    method: "POST",
    url: "/drafts",
    payload: {
      accountId: "account_personal",
      idea: "Make local automation auditable.",
      count: 2
    }
  });
  assert(created.statusCode === 201, "draft creation should return 201");
  const draft = created.json();
  assert(draft.candidates.length === 2, "draft should have 2 candidates");

  const approved = await app.inject({
    method: "POST",
    url: `/drafts/${draft.draft.id}/approve`,
    payload: {
      editedText: `${draft.draft.editedText}\n\nReviewed.`
    }
  });
  assert(approved.statusCode === 201, "draft approval should return 201");
  const job = approved.json().job;

  const prepared = await app.inject({
    method: "POST",
    url: `/jobs/${job.id}/prepare`
  });
  assert(prepared.statusCode === 200, "dry-run prepare should return 200");
  assert(prepared.json().job.status === "prepared", "job should be prepared");

  const attempts = await app.inject({
    method: "GET",
    url: `/jobs/${job.id}/attempts`
  });
  assert(attempts.statusCode === 200, "attempts should return 200");
  assert(attempts.json().attempts.length === 2, "prepare should record attempts");

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "fastify-app",
        draftId: draft.draft.id,
        jobId: job.id,
        finalJobStatus: prepared.json().job.status
      },
      null,
      2
    )
  );
} finally {
  await app.close();
}
