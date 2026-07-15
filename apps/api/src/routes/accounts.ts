import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { updateAccountRequestSchema } from "@zyquor/core";
import { assertDedicatedProfileDir } from "@zyquor/accounts";
import { definedEntries } from "../lib/utils.js";

export function registerAccountsRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/accounts", async () => ({
    accounts: await (await deps.repository).listAccounts()
  }));

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
}
