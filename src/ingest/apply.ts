import type { Logger } from "pino";
import type { SqliteDb } from "../db/index.js";
import {
  finalizeMarket,
  insertActivity,
  insertMarket,
  isEventProcessed,
  markEventProcessed,
  markPositionClaimed,
  updateMarketMeta,
  updateMarketPools,
  upsertPositionOnStake,
} from "../db/queries.js";
import type { DecodedResolveEvent, RawIndexerEvent } from "../types.js";
import { DecodeError, decodeResolveEvent } from "./decoder.js";

export type ApplyResult =
  | { status: "applied"; eventName: string }
  | { status: "skipped"; reason: "duplicate" | "unknown" | "decode_error"; detail?: string };

export type MarketMetaBackfill = (marketId: bigint) => Promise<{
  question?: string | null;
  description?: string | null;
  createdAt?: number | null;
} | null>;

/**
 * Apply a single raw RPC event inside an existing transaction (preferred),
 * or call applyEventTransactional for a self-contained transaction.
 */
export function applyDecodedEvent(
  db: SqliteDb,
  raw: RawIndexerEvent,
  decoded: DecodedResolveEvent,
): void {
  const marketId = Number(decoded.marketId);
  if (!Number.isSafeInteger(marketId)) {
    throw new Error(`market_id not safe integer: ${decoded.marketId}`);
  }

  const ts = raw.timestamp ?? new Date().toISOString();

  switch (decoded.eventName) {
    case "market_created": {
      insertMarket(db, {
        id: marketId,
        creator: decoded.creator,
        resolver: decoded.resolver,
        token: decoded.token,
        closeAt: Number(decoded.closeAt),
        resolutionTimeout: Number(decoded.resolutionTimeout),
        createdTx: raw.txHash,
        createdAt: null,
        question: null,
        description: null,
      });
      insertActivity(db, {
        userAddress: decoded.creator,
        marketId,
        type: "create",
        txHash: raw.txHash,
        ledger: raw.ledger,
        ts,
      });
      break;
    }
    case "staked": {
      updateMarketPools(
        db,
        marketId,
        decoded.yesPool.toString(),
        decoded.noPool.toString(),
      );
      upsertPositionOnStake(
        db,
        marketId,
        decoded.user,
        decoded.side,
        decoded.amount.toString(),
      );
      insertActivity(db, {
        userAddress: decoded.user,
        marketId,
        type: "stake",
        amount: decoded.amount.toString(),
        side: decoded.side,
        txHash: raw.txHash,
        ledger: raw.ledger,
        ts,
      });
      break;
    }
    case "market_resolved": {
      const status =
        decoded.outcome === "invalid" ? "invalid" : "resolved";
      finalizeMarket(
        db,
        marketId,
        status,
        decoded.outcome,
        null,
      );
      insertActivity(db, {
        userAddress: decoded.resolver,
        marketId,
        type: "resolve",
        outcome: decoded.outcome,
        txHash: raw.txHash,
        ledger: raw.ledger,
        ts,
      });
      break;
    }
    case "market_invalidated": {
      finalizeMarket(db, marketId, "invalid", "invalid", null);
      insertActivity(db, {
        userAddress: decoded.caller,
        marketId,
        type: "invalidate",
        outcome: "invalid",
        txHash: raw.txHash,
        ledger: raw.ledger,
        ts,
      });
      break;
    }
    case "claimed": {
      markPositionClaimed(db, marketId, decoded.user);
      insertActivity(db, {
        userAddress: decoded.user,
        marketId,
        type: "claim",
        amount: decoded.amount.toString(),
        claimKind: decoded.kind,
        txHash: raw.txHash,
        ledger: raw.ledger,
        ts,
      });
      break;
    }
  }

  markEventProcessed(
    db,
    raw.txHash,
    raw.eventIndex,
    decoded.eventName,
    raw.ledger,
  );
}

export function applyRawEvent(
  db: SqliteDb,
  raw: RawIndexerEvent,
  log?: Logger,
): ApplyResult {
  if (isEventProcessed(db, raw.txHash, raw.eventIndex)) {
    return { status: "skipped", reason: "duplicate" };
  }

  let decoded: DecodedResolveEvent | null;
  try {
    decoded = decodeResolveEvent(raw);
  } catch (err) {
    const detail = err instanceof DecodeError ? err.message : String(err);
    log?.warn(
      { err: detail, txHash: raw.txHash, eventIndex: raw.eventIndex },
      "failed to decode event",
    );
    return { status: "skipped", reason: "decode_error", detail };
  }

  if (!decoded) {
    return { status: "skipped", reason: "unknown" };
  }

  applyDecodedEvent(db, raw, decoded);
  return { status: "applied", eventName: decoded.eventName };
}

export async function maybeBackfillMarketMeta(
  db: SqliteDb,
  marketId: bigint,
  backfill: MarketMetaBackfill | undefined,
  log?: Logger,
): Promise<boolean> {
  if (!backfill) return false;
  const numericId = Number(marketId);
  if (!Number.isSafeInteger(numericId) || numericId < 0) {
    log?.warn(
      { marketId: marketId.toString() },
      "skipping market meta backfill for unsafe market id",
    );
    return false;
  }
  try {
    const meta = await backfill(marketId);
    if (!meta) return false;
    const patch: {
      question?: string | null;
      description?: string | null;
      createdAt?: number | null;
    } = {};
    if (typeof meta.question === "string" && meta.question.length > 0) {
      patch.question = meta.question;
    }
    if (typeof meta.description === "string") {
      patch.description = meta.description;
    }
    if (
      typeof meta.createdAt === "number" &&
      Number.isSafeInteger(meta.createdAt) &&
      meta.createdAt >= 0
    ) {
      patch.createdAt = meta.createdAt;
    }
    if (
      patch.question === undefined &&
      patch.description === undefined &&
      patch.createdAt === undefined
    ) {
      return false;
    }
    updateMarketMeta(db, numericId, patch);
    return true;
  } catch (err) {
    log?.warn(
      { err: String(err), marketId: marketId.toString() },
      "market meta backfill failed",
    );
    return false;
  }
}
