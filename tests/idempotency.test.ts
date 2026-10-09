import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyMigrations, openMemoryDatabase } from "../src/db/index.js";
import {
  clearCheckpoint,
  countProcessedEvents,
  getCheckpoint,
  getMarket,
  hasIndexedMarkets,
  isEventProcessed,
  listUserPositions,
  setCheckpoint,
} from "../src/db/queries.js";
import { applyRawEvent } from "../src/ingest/apply.js";
import { syntheticRawEvent } from "../src/ingest/decoder.js";

const CREATOR = "G" + "A".repeat(55);
const RESOLVER = "G" + "B".repeat(55);
const TOKEN = "C" + "C".repeat(55);
const USER = "G" + "D".repeat(55);

function setup() {
  const db = openMemoryDatabase();
  applyMigrations(db);
  return db;
}

describe("idempotent event apply", () => {
  it("can reset an empty deployment checkpoint for a configured backfill", () => {
    const db = setup();
    assert.equal(hasIndexedMarkets(db), false);
    setCheckpoint(db, "newest-cursor");
    assert.equal(getCheckpoint(db), "newest-cursor");
    clearCheckpoint(db);
    assert.equal(getCheckpoint(db), null);
    assert.equal(countProcessedEvents(db), 0);
  });

  it("applies market lifecycle once and skips duplicates", () => {
    const db = setup();

    const created = syntheticRawEvent(
      ["market_created", 1n, CREATOR],
      {
        resolver: RESOLVER,
        token: TOKEN,
        close_at: 2_000_000_000n,
        resolution_timeout: 3600n,
      },
      { txHash: "aa".repeat(32), eventIndex: 0, ledger: 100 },
    );

    const first = applyRawEvent(db, created);
    assert.equal(first.status, "applied");
    assert.ok(getMarket(db, 1));

    const dup = applyRawEvent(db, created);
    assert.equal(dup.status, "skipped");
    if (dup.status === "skipped") {
      assert.equal(dup.reason, "duplicate");
    }
    assert.equal(isEventProcessed(db, created.txHash, 0), true);
    assert.equal(countProcessedEvents(db), 1);

    const staked = syntheticRawEvent(
      ["staked", 1n, USER],
      { side: 0, amount: 100n, yes_pool: 100n, no_pool: 0n },
      { txHash: "bb".repeat(32), eventIndex: 1, ledger: 101 },
    );
    assert.equal(applyRawEvent(db, staked).status, "applied");
    assert.equal(applyRawEvent(db, staked).status, "skipped");

    const market = getMarket(db, 1)!;
    assert.equal(market.yes_pool, "100");
    assert.equal(market.no_pool, "0");

    const positions = listUserPositions(db, USER);
    assert.equal(positions.length, 1);
    assert.equal(positions[0]!.yes_amount, "100");

    // Second stake accumulates
    const staked2 = syntheticRawEvent(
      ["staked", 1n, USER],
      { side: 0, amount: 50n, yes_pool: 150n, no_pool: 0n },
      { txHash: "cc".repeat(32), eventIndex: 0, ledger: 102 },
    );
    assert.equal(applyRawEvent(db, staked2).status, "applied");
    assert.equal(listUserPositions(db, USER)[0]!.yes_amount, "150");
    assert.equal(getMarket(db, 1)!.yes_pool, "150");

    const resolved = syntheticRawEvent(
      ["market_resolved", 1n, RESOLVER],
      { outcome: 0 },
      { txHash: "dd".repeat(32), eventIndex: 0, ledger: 200 },
    );
    assert.equal(applyRawEvent(db, resolved).status, "applied");
    assert.equal(getMarket(db, 1)!.status, "resolved");
    assert.equal(getMarket(db, 1)!.outcome, "yes");

    const claimed = syntheticRawEvent(
      ["claimed", 1n, USER],
      { amount: 150n, kind: 0 },
      { txHash: "ee".repeat(32), eventIndex: 0, ledger: 201 },
    );
    assert.equal(applyRawEvent(db, claimed).status, "applied");
    assert.equal(listUserPositions(db, USER)[0]!.claimed, 1);
  });

  it("marks invalidated markets", () => {
    const db = setup();
    applyRawEvent(
      db,
      syntheticRawEvent(
        ["market_created", 5n, CREATOR],
        {
          resolver: RESOLVER,
          token: TOKEN,
          close_at: 1n,
          resolution_timeout: 1n,
        },
        { txHash: "11".repeat(32), eventIndex: 0, ledger: 1 },
      ),
    );
    applyRawEvent(
      db,
      syntheticRawEvent(
        ["market_invalidated", 5n, USER],
        {},
        { txHash: "22".repeat(32), eventIndex: 0, ledger: 2 },
      ),
    );
    const m = getMarket(db, 5)!;
    assert.equal(m.status, "invalid");
    assert.equal(m.outcome, "invalid");
  });
});
