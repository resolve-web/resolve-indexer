import type { Logger } from "pino";
import type { AppConfig } from "../config.js";
import { withTransaction, type SqliteDb } from "../db/index.js";
import {
  clearCheckpoint,
  getCheckpoint,
  hasIndexedMarkets,
  setCheckpoint,
} from "../db/queries.js";
import {
  applyRawEvent,
  maybeBackfillMarketMeta,
} from "./apply.js";
import {
  computeBackoffMs,
  sleep,
  SorobanEventClient,
} from "./rpc.js";

export type IngestWorkerOptions = {
  db: SqliteDb;
  config: AppConfig;
  log: Logger;
  client?: SorobanEventClient;
  /** Injected for tests — stop after N successful poll cycles. */
  maxCycles?: number;
};

export class IngestWorker {
  private readonly db: SqliteDb;
  private readonly config: AppConfig;
  private readonly log: Logger;
  private readonly client: SorobanEventClient;
  private readonly maxCycles?: number;
  private running = false;
  private stopped = false;
  private lastIngestAt: string | null = null;
  private cycles = 0;

  constructor(opts: IngestWorkerOptions) {
    this.db = opts.db;
    this.config = opts.config;
    this.log = opts.log.child({ component: "ingest" });
    this.client =
      opts.client ??
      new SorobanEventClient({
        rpcUrl: opts.config.sorobanRpcUrl,
        networkPassphrase: opts.config.networkPassphrase,
        contractId: opts.config.resolveContractId,
        log: this.log,
      });
    if (opts.maxCycles !== undefined) {
      this.maxCycles = opts.maxCycles;
    }
  }

  getLastIngestAt(): string | null {
    return this.lastIngestAt;
  }

  getCursor(): string | null {
    return getCheckpoint(this.db);
  }

  stop(): void {
    this.stopped = true;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this.log.info(
      {
        contractId: this.config.resolveContractId,
        pollIntervalMs: this.config.pollIntervalMs,
      },
      "ingest worker starting",
    );

    let failStreak = 0;

    while (!this.stopped) {
      try {
        await this.pollOnce();
        failStreak = 0;
        this.cycles += 1;
        if (this.maxCycles !== undefined && this.cycles >= this.maxCycles) {
          break;
        }
        await sleep(this.config.pollIntervalMs);
      } catch (err) {
        failStreak += 1;
        const wait = computeBackoffMs(failStreak);
        this.log.error(
          { err: String(err), failStreak, waitMs: wait },
          "ingest poll failed; backing off",
        );
        await sleep(wait);
      }
    }

    this.running = false;
    this.log.info("ingest worker stopped");
  }

  async pollOnce(): Promise<{ applied: number; skipped: number }> {
    if (!this.config.sorobanRpcUrl || !this.config.resolveContractId) {
      throw new Error(
        "SOROBAN_RPC_URL and RESOLVE_CONTRACT_ID are required for ingest",
      );
    }

    let checkpoint = getCheckpoint(this.db);
    if (
      checkpoint &&
      this.config.startLedger !== undefined &&
      !hasIndexedMarkets(this.db)
    ) {
      this.log.warn(
        { checkpoint, startLedger: this.config.startLedger },
        "empty index with a configured start ledger; replaying deployment history",
      );
      clearCheckpoint(this.db);
      checkpoint = null;
    }
    let startLedger = this.config.startLedger;
    let cursor = checkpoint ?? undefined;

    if (!cursor && startLedger === undefined) {
      const latest = await this.client.getLatestLedger();
      // Start a bit behind tip to avoid missing recent finalize; default ~50 ledgers.
      startLedger = Math.max(1, latest - 50);
      this.log.info({ startLedger, latest }, "no checkpoint; starting near tip");
    }

    const page = await this.client.getEvents({
      ...(cursor ? { cursor } : { startLedger: startLedger! }),
      limit: 200,
    });

    let applied = 0;
    let skipped = 0;
    const createdMarketIds: bigint[] = [];

    withTransaction(this.db, () => {
      for (const raw of page.events) {
        const result = applyRawEvent(this.db, raw, this.log);
        if (result.status === "applied") {
          applied += 1;
          if (result.eventName === "market_created") {
            const mid = extractMarketId(raw);
            if (mid !== null) createdMarketIds.push(mid);
          }
        } else {
          skipped += 1;
        }
      }

      // Prefer RPC paging cursor; fall back to ledger-based marker.
      const nextCursor =
        page.cursor ??
        (page.events.length > 0
          ? String(page.events[page.events.length - 1]!.ledger)
          : cursor ?? (startLedger !== undefined ? String(startLedger) : null));

      if (nextCursor) {
        setCheckpoint(this.db, nextCursor);
      }
    });
    this.lastIngestAt = new Date().toISOString();

    if (
      this.config.backfillMarketMeta &&
      createdMarketIds.length > 0
    ) {
      for (const marketId of createdMarketIds) {
        await maybeBackfillMarketMeta(
          this.db,
          marketId,
          (id) => this.client.getMarketMeta(id),
          this.log,
        );
      }
    }

    if (applied > 0 || page.events.length > 0) {
      this.log.info(
        {
          fetched: page.events.length,
          applied,
          skipped,
          cursor: getCheckpoint(this.db),
        },
        "ingest batch complete",
      );
    }

    return { applied, skipped };
  }
}

function extractMarketId(raw: {
  topics: unknown[];
}): bigint | null {
  const t = raw.topics[1];
  if (typeof t === "bigint") return t;
  if (typeof t === "number") return BigInt(t);
  if (typeof t === "string" && /^-?\d+$/.test(t)) return BigInt(t);
  return null;
}
