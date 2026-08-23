import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import {
  createKnowledgeEntryRequestSchema,
  updateKnowledgeEntryRequestSchema
} from "@zyquor/core";
import { definedEntries } from "../lib/utils.js";
import { HttpError } from "../lib/errors.js";

function accountIdFrom(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, "accountId is required");
  }
  return value;
}

export function registerKnowledgeRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/knowledge", async (request) => {
    const accountId = accountIdFrom((request.query as { accountId?: unknown }).accountId);
    const repository = await deps.repository;
    const account = await repository.getAccount(accountId);
    if (!account) {
      throw new HttpError(404, `Account not found: ${accountId}`);
    }
    return { entries: await repository.listKnowledgeEntries(accountId) };
  });

  app.post("/knowledge", async (request, reply) => {
    const input = createKnowledgeEntryRequestSchema.parse(request.body);
    const repository = await deps.repository;
    const account = await repository.getAccount(input.accountId);
    if (!account) {
      throw new HttpError(404, `Account not found: ${input.accountId}`);
    }
    return reply.code(201).send({ entry: await repository.createKnowledgeEntry(input) });
  });

  app.patch("/knowledge/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = updateKnowledgeEntryRequestSchema.parse(request.body);
    const repository = await deps.repository;
    try {
      return { entry: await repository.updateKnowledgeEntry(id, definedEntries(input)) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        throw new HttpError(404, error.message);
      }
      throw error;
    }
  });

  app.delete("/knowledge/:id", async (request) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    try {
      return { entry: await repository.deleteKnowledgeEntry(id) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        throw new HttpError(404, error.message);
      }
      throw error;
    }
  });
}
