import type { SqliteDb } from "./index.js";
import { nowIso } from "./index.js";
import type {
  ActivityRow,
  ClaimKind,
  MarketRow,
  MarketStatus,
  Outcome,
  PositionRow,
  Side,
} from "../types.js";

const CHECKPOINT_ID = 1;

export function getCheckpoint(db: SqliteDb): string | null {
  const row = db
    .prepare("SELECT cursor FROM checkpoints WHERE id = ?")
    .get(CHECKPOINT_ID) as { cursor: string } | undefined;
  return row?.cursor ?? null;
}

export function setCheckpoint(db: SqliteDb, cursor: string): void {
  db.prepare(
    `
    INSERT INTO checkpoints (id, cursor, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      cursor = excluded.cursor,
      updated_at = excluded.updated_at
    `,
  ).run(CHECKPOINT_ID, cursor, nowIso());
}

export function clearCheckpoint(db: SqliteDb): void {
  db.prepare("DELETE FROM checkpoints WHERE id = ?").run(CHECKPOINT_ID);
}

export function hasIndexedMarkets(db: SqliteDb): boolean {
  const row = db.prepare("SELECT 1 AS ok FROM markets LIMIT 1").get() as
    | { ok: number }
    | undefined;
  return Boolean(row);
}

export function getCheckpointUpdatedAt(db: SqliteDb): string | null {
  const row = db
    .prepare("SELECT updated_at FROM checkpoints WHERE id = ?")
    .get(CHECKPOINT_ID) as { updated_at: string } | undefined;
  return row?.updated_at ?? null;
}

export function isEventProcessed(
  db: SqliteDb,
  txHash: string,
  eventIndex: number,
): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS ok FROM processed_events WHERE tx_hash = ? AND event_index = ?",
    )
    .get(txHash, eventIndex) as { ok: number } | undefined;
  return Boolean(row);
}

export function markEventProcessed(
  db: SqliteDb,
  txHash: string,
  eventIndex: number,
  eventType: string,
  ledger: number | null,
): void {
  db.prepare(
    `
    INSERT INTO processed_events (tx_hash, event_index, event_type, ledger)
    VALUES (?, ?, ?, ?)
    `,
  ).run(txHash, eventIndex, eventType, ledger);
}

export function insertMarket(db: SqliteDb, market: {
  id: number;
  creator: string;
  resolver: string;
  token: string;
  closeAt: number;
  resolutionTimeout: number;
  createdTx: string;
  createdAt?: number | null;
  question?: string | null;
  description?: string | null;
}): void {
  db.prepare(
    `
    INSERT INTO markets (
      id, creator, resolver, question, description, token,
      created_at, close_at, resolution_timeout, yes_pool, no_pool,
      status, created_tx, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '0', '0', 'open', ?, ?)
    ON CONFLICT(id) DO NOTHING
    `,
  ).run(
    market.id,
    market.creator,
    market.resolver,
    market.question ?? null,
    market.description ?? null,
    market.token,
    market.createdAt ?? null,
    market.closeAt,
    market.resolutionTimeout,
    market.createdTx,
    nowIso(),
  );
}

export function updateMarketMeta(
  db: SqliteDb,
  id: number,
  meta: {
    question?: string | null;
    description?: string | null;
    createdAt?: number | null;
  },
): void {
  db.prepare(
    `
    UPDATE markets SET
      question = COALESCE(?, question),
      description = COALESCE(?, description),
      created_at = COALESCE(?, created_at),
      updated_at = ?
    WHERE id = ?
    `,
  ).run(
    meta.question ?? null,
    meta.description ?? null,
    meta.createdAt ?? null,
    nowIso(),
    id,
  );
}

export function updateMarketPools(
  db: SqliteDb,
  id: number,
  yesPool: string,
  noPool: string,
): void {
  db.prepare(
    `
    UPDATE markets SET yes_pool = ?, no_pool = ?, updated_at = ?
    WHERE id = ?
    `,
  ).run(yesPool, noPool, nowIso(), id);
}

export function finalizeMarket(
  db: SqliteDb,
  id: number,
  status: MarketStatus,
  outcome: Outcome | null,
  finalizedAt: number | null,
): void {
  db.prepare(
    `
    UPDATE markets SET
      status = ?,
      outcome = ?,
      finalized_at = COALESCE(?, finalized_at),
      updated_at = ?
    WHERE id = ?
    `,
  ).run(status, outcome, finalizedAt, nowIso(), id);
}

export function upsertPositionOnStake(
  db: SqliteDb,
  marketId: number,
  user: string,
  side: Side,
  amount: string,
): void {
  const existing = db
    .prepare(
      "SELECT yes_amount, no_amount, claimed FROM positions WHERE market_id = ? AND user_address = ?",
    )
    .get(marketId, user) as
    | { yes_amount: string; no_amount: string; claimed: number }
    | undefined;

  if (!existing) {
    db.prepare(
      `
      INSERT INTO positions (market_id, user_address, yes_amount, no_amount, claimed, updated_at)
      VALUES (?, ?, ?, ?, 0, ?)
      `,
    ).run(
      marketId,
      user,
      side === "yes" ? amount : "0",
      side === "no" ? amount : "0",
      nowIso(),
    );
    return;
  }

  const yes =
    side === "yes"
      ? addBigIntStrings(existing.yes_amount, amount)
      : existing.yes_amount;
  const no =
    side === "no"
      ? addBigIntStrings(existing.no_amount, amount)
      : existing.no_amount;

  db.prepare(
    `
    UPDATE positions SET yes_amount = ?, no_amount = ?, updated_at = ?
    WHERE market_id = ? AND user_address = ?
    `,
  ).run(yes, no, nowIso(), marketId, user);
}

export function markPositionClaimed(
  db: SqliteDb,
  marketId: number,
  user: string,
): void {
  db.prepare(
    `
    INSERT INTO positions (market_id, user_address, yes_amount, no_amount, claimed, updated_at)
    VALUES (?, ?, '0', '0', 1, ?)
    ON CONFLICT(market_id, user_address) DO UPDATE SET
      claimed = 1,
      updated_at = excluded.updated_at
    `,
  ).run(marketId, user, nowIso());
}

export function insertActivity(
  db: SqliteDb,
  row: {
    userAddress: string;
    marketId: number;
    type: ActivityRow["type"];
    amount?: string | null;
    side?: Side | null;
    outcome?: Outcome | null;
    claimKind?: ClaimKind | null;
    txHash: string;
    ledger: number | null;
    ts: string;
  },
): void {
  db.prepare(
    `
    INSERT INTO activity (
      user_address, market_id, type, amount, side, outcome, claim_kind,
      tx_hash, ledger, ts
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tx_hash, type, user_address, market_id) DO NOTHING
    `,
  ).run(
    row.userAddress,
    row.marketId,
    row.type,
    row.amount ?? null,
    row.side ?? null,
    row.outcome ?? null,
    row.claimKind ?? null,
    row.txHash,
    row.ledger,
    row.ts,
  );
}

export function getMarket(db: SqliteDb, id: number): MarketRow | null {
  return (
    (db.prepare("SELECT * FROM markets WHERE id = ?").get(id) as
      | MarketRow
      | undefined) ?? null
  );
}

export function listMarkets(
  db: SqliteDb,
  opts: {
    status?: MarketStatus;
    limit: number;
    cursor?: number;
  },
): MarketRow[] {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  if (opts.status && opts.cursor !== undefined) {
    return db
      .prepare(
        `
        SELECT * FROM markets
        WHERE status = ? AND id < ?
        ORDER BY id DESC
        LIMIT ?
        `,
      )
      .all(opts.status, opts.cursor, limit) as MarketRow[];
  }
  if (opts.status) {
    return db
      .prepare(
        `
        SELECT * FROM markets
        WHERE status = ?
        ORDER BY id DESC
        LIMIT ?
        `,
      )
      .all(opts.status, limit) as MarketRow[];
  }
  if (opts.cursor !== undefined) {
    return db
      .prepare(
        `
        SELECT * FROM markets
        WHERE id < ?
        ORDER BY id DESC
        LIMIT ?
        `,
      )
      .all(opts.cursor, limit) as MarketRow[];
  }
  return db
    .prepare(
      `
      SELECT * FROM markets
      ORDER BY id DESC
      LIMIT ?
      `,
    )
    .all(limit) as MarketRow[];
}

export function listMarketPositions(
  db: SqliteDb,
  marketId: number,
): PositionRow[] {
  return db
    .prepare(
      `
      SELECT * FROM positions
      WHERE market_id = ?
      ORDER BY user_address ASC
      `,
    )
    .all(marketId) as PositionRow[];
}

export function listUserPositions(
  db: SqliteDb,
  userAddress: string,
): PositionRow[] {
  return db
    .prepare(
      `
      SELECT * FROM positions
      WHERE user_address = ?
      ORDER BY market_id DESC
      `,
    )
    .all(userAddress) as PositionRow[];
}

export function listUserActivity(
  db: SqliteDb,
  userAddress: string,
  opts: { limit: number; cursor?: number },
): ActivityRow[] {
  const limit = Math.min(Math.max(opts.limit, 1), 100);
  if (opts.cursor !== undefined) {
    return db
      .prepare(
        `
        SELECT * FROM activity
        WHERE user_address = ? AND id < ?
        ORDER BY id DESC
        LIMIT ?
        `,
      )
      .all(userAddress, opts.cursor, limit) as ActivityRow[];
  }
  return db
    .prepare(
      `
      SELECT * FROM activity
      WHERE user_address = ?
      ORDER BY id DESC
      LIMIT ?
      `,
    )
    .all(userAddress, limit) as ActivityRow[];
}

function addBigIntStrings(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}
