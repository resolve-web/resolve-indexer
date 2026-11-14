import type { FastifyPluginAsync } from "fastify";
import { z } from "zod/v3";
import { listUserActivity, listUserPositions } from "../db/queries.js";
import type { ActivityRow, PositionRow } from "../types.js";
import {
  formatZodError,
  PaginationSchema,
  StellarAddressSchema,
} from "./validation.js";

function serializePosition(p: PositionRow) {
  return {
    marketId: p.market_id,
    userAddress: p.user_address,
    yesAmount: p.yes_amount,
    noAmount: p.no_amount,
    claimed: Boolean(p.claimed),
    updatedAt: p.updated_at,
  };
}

function serializeActivity(a: ActivityRow) {
  return {
    id: a.id,
    userAddress: a.user_address,
    marketId: a.market_id,
    type: a.type,
    amount: a.amount,
    side: a.side,
    outcome: a.outcome,
    claimKind: a.claim_kind,
    txHash: a.tx_hash,
    ledger: a.ledger,
    ts: a.ts,
  };
}

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get("/users/:address/positions", async (req, reply) => {
    const params = z
      .object({ address: StellarAddressSchema })
      .safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send(formatZodError(params.error));
    }

    const positions = listUserPositions(app.db, params.data.address);
    return reply.send({
      address: params.data.address,
      positions: positions.map(serializePosition),
    });
  });

  app.get("/users/:address/activity", async (req, reply) => {
    const params = z
      .object({ address: StellarAddressSchema })
      .safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send(formatZodError(params.error));
    }
    const query = PaginationSchema.safeParse(req.query);
    if (!query.success) {
      return reply.status(400).send(formatZodError(query.error));
    }

    const { limit, cursor } = query.data;
    const rows = listUserActivity(app.db, params.data.address, {
      limit,
      ...(cursor !== undefined ? { cursor } : {}),
    });

    const nextCursor = rows.length > 0 ? rows[rows.length - 1]!.id : null;

    return reply.send({
      address: params.data.address,
      activity: rows.map(serializeActivity),
      nextCursor,
    });
  });
};
