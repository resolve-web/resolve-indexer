import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { StrKey } from "@stellar/stellar-sdk";

import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("defaults to the verified Resolve testnet deployment", () => {
    const config = loadConfig({});
    assert.equal(config.resolveContractId, "CD3YJNAYKVKT72DYPVS644OPNVNW6673TUIQWGXXA4VQD7536ARWB6MZ");
    assert.equal(config.sorobanRpcUrl, "https://soroban-testnet.stellar.org");
  });
  it("accepts a valid contract address", () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 2));
    assert.equal(loadConfig({ RESOLVE_CONTRACT_ID: contractId }).resolveContractId, contractId);
  });

  it("rejects malformed contract addresses", () => {
    assert.throws(() => loadConfig({ RESOLVE_CONTRACT_ID: "CINVALID" }), /valid Stellar contract/);
  });
});
