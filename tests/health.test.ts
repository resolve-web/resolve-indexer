import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FastifyInstance } from "fastify";
import { applyMigrations, openMemoryDatabase } from "../src/db/index.js";
import { buildServer } from "../src/server.js";

describe("GET /health", () => {
  let app: FastifyInstance;

  before(async () => {
    const db = openMemoryDatabase();
    applyMigrations(db);
    app = await buildServer({
      db,
      logger: false,
      corsOrigins: ["https://resolve.example"],
      health: {
        getCursor: () => "12345",
        getLastIngestAt: () => "2026-01-01T00:00:00.000Z",
      },
    });
  });

  it("allows configured browser origins", async () => {
    const res = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://resolve.example" } });
    assert.equal(res.headers["access-control-allow-origin"], "https://resolve.example");
  });

  after(async () => {
    await app.close();
  });

  it("returns status, cursor, lastIngestAt", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.cursor, "12345");
    assert.equal(body.lastIngestAt, "2026-01-01T00:00:00.000Z");
  });
});
