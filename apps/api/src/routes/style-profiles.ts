import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../deps.js";
import { updateStyleProfileRequestSchema } from "@zyquor/core";
import { definedEntries } from "../lib/utils.js";

export function registerStyleProfilesRoutes(app: FastifyInstance, deps: AppDeps): void {
  app.get("/style-profiles/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const repository = await deps.repository;
    const profile = await repository.getStyleProfile(id);
    if (!profile) {
      return reply.code(404).send({ error: "Style profile not found" });
    }

    return { profile };
  });

  app.patch("/style-profiles/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = updateStyleProfileRequestSchema.parse(request.body);
    const repository = await deps.repository;

    return {
      profile: await repository.updateStyleProfile(id, definedEntries(input))
    };
  });
}
