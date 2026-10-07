import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StrKey } from "@stellar/stellar-sdk";

import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("accepts a valid contract address", () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 2));
    assert.equal(loadConfig({ RESOLVE_CONTRACT_ID: contractId }).resolveContractId, contractId);
  });

  it("rejects malformed contract addresses", () => {
    assert.throws(() => loadConfig({ RESOLVE_CONTRACT_ID: "CINVALID" }), /valid Stellar contract/);
  });
});
