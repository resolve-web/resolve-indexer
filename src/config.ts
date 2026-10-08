import { z } from "zod";
import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { StrKey } from "@stellar/stellar-sdk";

loadDotenv();

const boolFromEnv = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    const s = v.trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes";
  });

const ConfigSchema = z.object({
  STELLAR_NETWORK: z.string().default("testnet"),
  SOROBAN_RPC_URL: z.string().url().or(z.literal("")).default("https://soroban-testnet.stellar.org"),
  RESOLVE_CONTRACT_ID: z.string().default("CD3YJNAYKVKT72DYPVS644OPNVNW6673TUIQWGXXA4VQD7536ARWB6MZ"),
  NETWORK_PASSPHRASE: z
    .string()
    .default("Test SDF Network ; September 2015"),
  DATABASE_PATH: z.string().default("./data/indexer.sqlite"),
  PORT: z.coerce.number().int().positive().default(3080),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  START_LEDGER: z
    .string()
    .optional()
    .transform((v) => {
      if (!v || v.trim() === "") return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error("START_LEDGER must be a non-negative number");
      }
      return Math.floor(n);
    }),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  BACKFILL_MARKET_META: boolFromEnv.default(true),
  HOST: z.string().default("0.0.0.0"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
});

export type AppConfig = {
  stellarNetwork: string;
  sorobanRpcUrl: string;
  resolveContractId: string;
  networkPassphrase: string;
  databasePath: string;
  port: number;
  pollIntervalMs: number;
  startLedger?: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  backfillMarketMeta: boolean;
  host: string;
  corsOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.parse(env);
  if (parsed.RESOLVE_CONTRACT_ID && !StrKey.isValidContract(parsed.RESOLVE_CONTRACT_ID)) {
    throw new Error("RESOLVE_CONTRACT_ID must be a valid Stellar contract address");
  }
  const databasePath = path.isAbsolute(parsed.DATABASE_PATH)
    ? parsed.DATABASE_PATH
    : path.resolve(process.cwd(), parsed.DATABASE_PATH);

  const config: AppConfig = {
    stellarNetwork: parsed.STELLAR_NETWORK,
    sorobanRpcUrl: parsed.SOROBAN_RPC_URL,
    resolveContractId: parsed.RESOLVE_CONTRACT_ID,
    networkPassphrase: parsed.NETWORK_PASSPHRASE,
    databasePath,
    port: parsed.PORT,
    pollIntervalMs: parsed.POLL_INTERVAL_MS,
    logLevel: parsed.LOG_LEVEL,
    backfillMarketMeta: parsed.BACKFILL_MARKET_META,
    host: parsed.HOST,
    corsOrigins: parsed.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
  };

  if (parsed.START_LEDGER !== undefined) {
    config.startLedger = parsed.START_LEDGER;
  }

  return config;
}

/** Config suitable for HTTP-only / test runs without RPC credentials. */
export function loadConfigLoose(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return loadConfig(env);
}
