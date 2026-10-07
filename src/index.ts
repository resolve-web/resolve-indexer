import pino from "pino";
import { loadConfig } from "./config.js";
import { applyMigrations, openDatabase } from "./db/index.js";
import { IngestWorker } from "./ingest/worker.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({
    level: config.logLevel,
    name: "resolve-indexer",
    ...(process.env.NODE_ENV !== "production"
      ? {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:standard" },
          },
        }
      : {}),
  });

  const db = openDatabase(config.databasePath);
  applyMigrations(db);

  const worker =
    config.sorobanRpcUrl && config.resolveContractId
      ? new IngestWorker({ db, config, log })
      : null;

  if (!worker) {
    log.warn(
      "SOROBAN_RPC_URL or RESOLVE_CONTRACT_ID missing — HTTP API only, ingest disabled",
    );
  }

  const app = await buildServer({
    db,
    logger: true,
    corsOrigins: config.corsOrigins,
    health: {
      getCursor: () => worker?.getCursor() ?? null,
      getLastIngestAt: () => worker?.getLastIngestAt() ?? null,
      isIngestEnabled: () => worker !== null,
    },
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    worker?.stop();
    try {
      await app.close();
    } finally {
      db.close();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
  log.info({ port: config.port, host: config.host }, "HTTP server listening");

  if (worker) {
    // Run ingest loop without blocking listen; unhandled rejection → log
    void worker.start().catch((err) => {
      log.fatal({ err: String(err) }, "ingest worker crashed");
      process.exit(1);
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
