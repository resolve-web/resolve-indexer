import Fastify, { type FastifyInstance } from "fastify";
import type { SqliteDb } from "./db/index.js";
import { healthRoutes, type HealthDeps } from "./routes/health.js";
import { marketRoutes } from "./routes/markets.js";
import { userRoutes } from "./routes/users.js";

export type BuildServerOptions = {
  db: SqliteDb;
  health: HealthDeps;
  /** When false, disables Fastify logging (useful in tests). */
  logger?: boolean;
  corsOrigins?: string[];
};

export async function buildServer(
  opts: BuildServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? true,
  });

  app.decorate("db", opts.db);

  const allowedOrigins = new Set(opts.corsOrigins ?? []);
  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      reply.header("access-control-allow-methods", "GET,OPTIONS");
      reply.header("access-control-allow-headers", "content-type");
      return reply.status(204).send();
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    const statusCode =
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      typeof (err as { statusCode: unknown }).statusCode === "number"
        ? (err as { statusCode: number }).statusCode
        : 500;

    if (statusCode >= 500) {
      app.log.error({ err }, "unhandled error");
      return reply.status(500).send({ error: "internal_error" });
    }

    const message = err instanceof Error ? err.message : "request_error";
    return reply.status(statusCode).send({ error: message });
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send({ error: "not_found" });
  });

  await app.register(healthRoutes, { deps: opts.health });
  await app.register(marketRoutes);
  await app.register(userRoutes);

  return app;
}
