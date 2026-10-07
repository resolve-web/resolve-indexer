import type { FastifyPluginAsync } from "fastify";
import { getCheckpoint, getCheckpointUpdatedAt } from "../db/queries.js";

export type HealthDeps = {
  getCursor: () => string | null;
  getLastIngestAt: () => string | null;
  isIngestEnabled?: () => boolean;
};

export const healthRoutes: FastifyPluginAsync<{ deps: HealthDeps }> = async (
  app,
  opts,
) => {
  app.get("/health", async (_req, reply) => {
    const cursor =
      opts.deps.getCursor() ?? getCheckpoint(app.db) ?? null;
    const lastIngestAt =
      opts.deps.getLastIngestAt() ?? getCheckpointUpdatedAt(app.db);

    return reply.send({
      status: "ok",
      cursor,
      lastIngestAt,
    });
  });

  app.get("/ready", async (_req, reply) => {
    const ingestEnabled = opts.deps.isIngestEnabled?.() ?? true;
    const cursor = opts.deps.getCursor() ?? getCheckpoint(app.db) ?? null;
    const ready = ingestEnabled && cursor !== null;
    return reply.status(ready ? 200 : 503).send({
      status: ready ? "ready" : "not_ready",
      ingestEnabled,
      cursor,
    });
  });
};

declare module "fastify" {
  interface FastifyInstance {
    db: import("../db/index.js").SqliteDb;
  }
}
