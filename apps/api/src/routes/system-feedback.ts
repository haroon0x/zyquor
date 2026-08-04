import type { FastifyInstance } from "fastify";
import { appendNotebookEntry, resolveFeedbackDir } from "../lib/feedback-notebook.js";
import { createSystemFeedbackRequestSchema } from "@zyquor/core";
import type { AppDeps } from "../deps.js";

export function registerSystemFeedbackRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/system-feedback", async (request) => {
    const { accountId } = request.query as { accountId?: string };
    const repository = await deps.repository;
    if (accountId) {
      return { items: await repository.listSystemFeedback(accountId) };
    }
    const accounts = await repository.listAccounts();
    const items = [];
    for (const account of accounts) {
      items.push(...(await repository.listSystemFeedback(account.id)));
    }
    return { items };
  });

  app.post("/system-feedback", async (request, reply) => {
    const input = createSystemFeedbackRequestSchema.parse(request.body);
    const repository = await deps.repository;
    const item = await repository.addSystemFeedback(input.accountId, input.text);
    const notebookDir = resolveFeedbackDir(deps.desktopSettings?.get().feedbackDir);
    appendNotebookEntry({
      dir: notebookDir,
      heading: `[standing] ${item.createdAt} — account ${input.accountId}`,
      lines: [
        `Standing correction applied to every future generation.`,
        "",
        `> ${input.text}`
      ]
    });
    return reply.code(201).send({ item });
  });

  app.delete("/system-feedback/:id", async (request) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    await repository.deleteSystemFeedback(id);
    return { deleted: true };
  });
}