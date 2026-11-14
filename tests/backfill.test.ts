import assert from "node:assert/strict";
import { describe, it } from "node:test";
import pino from "pino";
import {
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  type rpc,
} from "@stellar/stellar-sdk";
import { loadConfig } from "../src/config.js";
import { applyMigrations, openMemoryDatabase } from "../src/db/index.js";
import {
  getCheckpoint,
  getMarket,
  listMarketIdsMissingMeta,
} from "../src/db/queries.js";
import { syntheticRawEvent } from "../src/ingest/decoder.js";
import { SorobanEventClient, type RpcServerLike } from "../src/ingest/rpc.js";
import { IngestWorker } from "../src/ingest/worker.js";
import type { RawIndexerEvent } from "../src/types.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 9));
const CREATOR = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const RESOLVER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const TOKEN = StrKey.encodeContract(Buffer.alloc(32, 3));
const SILENT_LOG = pino({ level: "silent" });

function setupDb() {
  const db = openMemoryDatabase();
  applyMigrations(db);
  return db;
}

function makeMarketCreatedEvent(
  marketId: bigint,
  ledger: number,
  txByte: string,
): RawIndexerEvent {
  return syntheticRawEvent(
    ["market_created", marketId, CREATOR],
    {
      resolver: RESOLVER,
      token: TOKEN,
      close_at: 2_000_000_000n,
      resolution_timeout: 3600n,
    },
    { txHash: txByte.repeat(64), eventIndex: 0, ledger },
  );
}

describe("market metadata backfill via get_market", () => {
  it("skips get_market RPC calls completely when BACKFILL_MARKET_META=false", async () => {
    const db = setupDb();
    const config = loadConfig({
      RESOLVE_CONTRACT_ID: CONTRACT_ID,
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      BACKFILL_MARKET_META: "false",
      START_LEDGER: "100",
    });

    let getMarketMetaCalls = 0;
    const mockClient = {
      getLatestLedger: async () => 150,
      getEvents: async () => ({
        events: [makeMarketCreatedEvent(1n, 105, "a")],
        cursor: "cursor-105",
        latestLedger: 150,
      }),
      getMarketMeta: async () => {
        getMarketMetaCalls += 1;
        return {
          question: "Should not be fetched",
          description: "Disabled by config",
          createdAt: 1_900_000_000,
        };
      },
    } as unknown as SorobanEventClient;

    const worker = new IngestWorker({
      db,
      config,
      log: SILENT_LOG,
      client: mockClient,
    });

    const res = await worker.pollOnce();
    assert.equal(res.applied, 1);
    assert.equal(getCheckpoint(db), "cursor-105");
    assert.equal(getMarketMetaCalls, 0);

    const market = getMarket(db, 1)!;
    assert.equal(market.question, null);
    assert.equal(market.description, null);
  });

  it("does not block checkpoint on RPC errors and heals missing metadata on a later cycle", async () => {
    const db = setupDb();
    const config = loadConfig({
      RESOLVE_CONTRACT_ID: CONTRACT_ID,
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      BACKFILL_MARKET_META: "true",
      START_LEDGER: "200",
    });

    let pollCount = 0;
    let metaAttemptsForMarket1 = 0;

    const mockClient = {
      getLatestLedger: async () => 250,
      getEvents: async () => {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            events: [
              makeMarketCreatedEvent(1n, 201, "b"),
              makeMarketCreatedEvent(2n, 202, "c"),
            ],
            cursor: "cursor-202",
            latestLedger: 250,
          };
        }
        return {
          events: [],
          cursor: "cursor-250",
          latestLedger: 250,
        };
      },
      getMarketMeta: async (marketId: bigint) => {
        if (marketId === 1n) {
          metaAttemptsForMarket1 += 1;
          if (metaAttemptsForMarket1 === 1) {
            throw new Error("RPC timeout during get_market(1)");
          }
          return {
            question: "Recovered market 1 question?",
            description: "Recovered on subsequent poll cycle",
            createdAt: 1_900_000_111,
          };
        }
        return {
          question: "Market 2 question?",
          description: "Populated immediately despite sibling error",
          createdAt: 1_900_000_222,
        };
      },
    } as unknown as SorobanEventClient;

    const worker = new IngestWorker({
      db,
      config,
      log: SILENT_LOG,
      client: mockClient,
    });

    // Cycle 1: market 1 backfill throws, but checkpoint advances AND market 2 still populates.
    const first = await worker.pollOnce();
    assert.equal(first.applied, 2);
    assert.equal(getCheckpoint(db), "cursor-202");
    assert.equal(getMarket(db, 1)!.question, null);
    assert.equal(getMarket(db, 2)!.question, "Market 2 question?");
    assert.deepEqual(listMarketIdsMissingMeta(db), [1n]);

    // Cycle 2: zero new events, missing metadata for market 1 is retried and populated cleanly.
    const second = await worker.pollOnce();
    assert.equal(second.applied, 0);
    assert.equal(getCheckpoint(db), "cursor-250");
    assert.equal(getMarket(db, 1)!.question, "Recovered market 1 question?");
    assert.equal(
      getMarket(db, 1)!.description,
      "Recovered on subsequent poll cycle",
    );
    assert.equal(getMarket(db, 1)!.created_at, 1_900_000_111);
    assert.deepEqual(listMarketIdsMissingMeta(db), []);
  });

  it("simulates get_market via SorobanEventClient with mocked RPC server responses and handles simulation errors", async () => {
    let mode: "ok" | "sim_error" | "throw" = "ok";

    const mockServer: RpcServerLike = {
      getLatestLedger: async () => ({
        id: "ledger-1",
        protocolVersion: 22,
        sequence: 500,
      }),
      getEvents: async () =>
        ({
          events: [],
          latestLedger: 500,
          cursor: "500",
        }) as unknown as Awaited<ReturnType<rpc.Server["getEvents"]>>,
      simulateTransaction: async () => {
        if (mode === "throw") {
          throw new Error("socket hang up");
        }
        if (mode === "sim_error") {
          return {
            id: "sim-err",
            latestLedger: 500,
            events: [],
            _parsed: true,
            error: "HostError: Error(Contract, #1)",
          } as rpc.Api.SimulateTransactionErrorResponse;
        }
        return {
          id: "sim-ok",
          latestLedger: 500,
          events: [],
          _parsed: true,
          transactionData: new SorobanDataBuilder(),
          minResourceFee: "100",
          result: {
            auth: [],
            retval: nativeToScVal({
              id: 7n,
              question: "Will Soroban protocol upgrade pass?",
              description: "Validator vote threshold check",
              created_at: 1_850_000_000n,
            }),
          },
        } as rpc.Api.SimulateTransactionSuccessResponse;
      },
    };

    const client = new SorobanEventClient({
      rpcUrl: "http://127.0.0.1:8000/rpc",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT_ID,
      log: SILENT_LOG,
      server: mockServer,
    });

    const okMeta = await client.getMarketMeta(7n);
    assert.deepEqual(okMeta, {
      question: "Will Soroban protocol upgrade pass?",
      description: "Validator vote threshold check",
      createdAt: 1_850_000_000,
    });

    mode = "sim_error";
    assert.equal(await client.getMarketMeta(7n), null);

    mode = "throw";
    assert.equal(await client.getMarketMeta(7n), null);
  });
});
