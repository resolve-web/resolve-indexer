import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeResolveEvent,
  syntheticRawEvent,
} from "../src/ingest/decoder.js";

// 56-char address-shaped strings (checksum not required for decoder tests)
const CREATOR = "G" + "A".repeat(55);
const RESOLVER = "G" + "B".repeat(55);
const TOKEN = "C" + "C".repeat(55);
const USER = "G" + "D".repeat(55);

describe("decodeResolveEvent", () => {
  it("decodes market_created from map data", () => {
    const raw = syntheticRawEvent(
      ["market_created", 7n, CREATOR],
      {
        resolver: RESOLVER,
        token: TOKEN,
        close_at: 1_700_000_000n,
        resolution_timeout: 3600n,
      },
    );
    const ev = decodeResolveEvent(raw);
    assert.ok(ev);
    assert.equal(ev.eventName, "market_created");
    if (ev.eventName === "market_created") {
      assert.equal(ev.marketId, 7n);
      assert.equal(ev.creator, CREATOR);
      assert.equal(ev.resolver, RESOLVER);
      assert.equal(ev.token, TOKEN);
      assert.equal(ev.closeAt, 1_700_000_000n);
      assert.equal(ev.resolutionTimeout, 3600n);
    }
  });

  it("decodes market_created from vec/indexed data", () => {
    const raw = syntheticRawEvent(
      ["market_created", 1, CREATOR],
      [RESOLVER, TOKEN, 100, 7200],
    );
    const ev = decodeResolveEvent(raw);
    assert.ok(ev);
    assert.equal(ev!.eventName, "market_created");
  });

  it("decodes staked with numeric side enum", () => {
    const raw = syntheticRawEvent(
      ["staked", 3n, USER],
      { side: 0, amount: 500n, yes_pool: 500n, no_pool: 0n },
    );
    const ev = decodeResolveEvent(raw);
    assert.ok(ev);
    assert.equal(ev!.eventName, "staked");
    if (ev!.eventName === "staked") {
      assert.equal(ev.side, "yes");
      assert.equal(ev.amount, 500n);
    }
  });

  it("decodes staked with tagged side object", () => {
    const raw = syntheticRawEvent(
      ["staked", 3n, USER],
      { side: { tag: "No" }, amount: "10", yes_pool: "0", no_pool: "10" },
    );
    const ev = decodeResolveEvent(raw);
    assert.ok(ev && ev.eventName === "staked");
    if (ev && ev.eventName === "staked") {
      assert.equal(ev.side, "no");
      assert.equal(ev.amount, 10n);
    }
  });

  it("decodes market_resolved", () => {
    const raw = syntheticRawEvent(
      ["market_resolved", 9n, RESOLVER],
      { outcome: 1 },
    );
    const ev = decodeResolveEvent(raw);
    assert.ok(ev && ev.eventName === "market_resolved");
    if (ev && ev.eventName === "market_resolved") {
      assert.equal(ev.outcome, "no");
    }
  });

  it("decodes market_invalidated", () => {
    const raw = syntheticRawEvent(
      ["market_invalidated", 2n, USER],
      {},
    );
    const ev = decodeResolveEvent(raw);
    assert.ok(ev && ev.eventName === "market_invalidated");
    if (ev && ev.eventName === "market_invalidated") {
      assert.equal(ev.caller, USER);
    }
  });

  it("decodes claimed with payout/refund kinds", () => {
    const payout = decodeResolveEvent(
      syntheticRawEvent(["claimed", 1n, USER], { amount: 42n, kind: 0 }),
    );
    assert.ok(payout && payout.eventName === "claimed");
    if (payout && payout.eventName === "claimed") {
      assert.equal(payout.kind, "payout");
    }

    const refund = decodeResolveEvent(
      syntheticRawEvent(["claimed", 1n, USER], {
        amount: 42n,
        kind: { tag: "Refund" },
      }),
    );
    assert.ok(refund && refund.eventName === "claimed");
    if (refund && refund.eventName === "claimed") {
      assert.equal(refund.kind, "refund");
    }
  });

  it("decodes the enum vector shape emitted by live Soroban events", () => {
    const staked = decodeResolveEvent(
      syntheticRawEvent(
        ["staked", 1n, USER],
        { side: ["Yes"], amount: 10n, yes_pool: 10n, no_pool: 0n },
      ),
    );
    assert.ok(staked && staked.eventName === "staked");
    if (staked && staked.eventName === "staked") {
      assert.equal(staked.side, "yes");
    }

    const resolved = decodeResolveEvent(
      syntheticRawEvent(
        ["market_resolved", 1n, RESOLVER],
        { outcome: ["Yes"] },
      ),
    );
    assert.ok(resolved && resolved.eventName === "market_resolved");
    if (resolved && resolved.eventName === "market_resolved") {
      assert.equal(resolved.outcome, "yes");
    }

    const claimed = decodeResolveEvent(
      syntheticRawEvent(
        ["claimed", 1n, USER],
        { amount: 10n, kind: ["Payout"] },
      ),
    );
    assert.ok(claimed && claimed.eventName === "claimed");
    if (claimed && claimed.eventName === "claimed") {
      assert.equal(claimed.kind, "payout");
    }
  });

  it("returns null for unknown event names", () => {
    const raw = syntheticRawEvent(["something_else", 1n], {});
    assert.equal(decodeResolveEvent(raw), null);
  });
});
