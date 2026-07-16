import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { createAccountRequestSchema, updateAccountRequestSchema } from "@zyquor/core";
import { assertDedicatedProfileDir } from "@zyquor/accounts";
import { definedEntries } from "../lib/utils.js";
import { HttpError } from "../lib/errors.js";

export function registerAccountsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/accounts", async () => ({
    accounts: await (await deps.repository).listAccounts()
  }));

  app.post("/accounts", async (request, reply) => {
    const input = createAccountRequestSchema.parse(request.body);
    assertDedicatedProfileDir(input.profileDir);
    const account = await (await deps.repository).createAccount(input);
    return reply.code(201).send({ account });
  });

  app.patch("/accounts/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = updateAccountRequestSchema.parse(request.body);
    const repository = await deps.repository;

    if (input.profileDir) {
      assertDedicatedProfileDir(input.profileDir);
    }

    return {
      account: await repository.updateAccount(id, definedEntries(input))
    };
  });

  app.delete("/accounts/:id", async (request) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    const account = await repository.getAccount(id);
    if (!account) {
      throw new HttpError(404, `Account not found: ${id}`);
    }
    if ((await repository.listAccounts()).length === 1) {
      throw new HttpError(409, "Cannot delete the last remaining account");
    }
    return { account: await repository.deleteAccount(id) };
  });
}
