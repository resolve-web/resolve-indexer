import type { FastifyPluginAsync } from "fastify";
import { z } from "zod/v3";
import {
  getMarket,
  listMarketPositions,
  listMarkets,
} from "../db/queries.js";
import type { MarketRow, PositionRow } from "../types.js";
import {
  formatZodError,
  MarketIdSchema,
  MarketStatusQuerySchema,
  PaginationSchema,
} from "./validation.js";

function serializeMarket(m: MarketRow) {
  return {
    id: m.id,
    creator: m.creator,
    resolver: m.resolver,
    question: m.question,
    description: m.description,
    token: m.token,
    createdAt: m.created_at,
    closeAt: m.close_at,
    resolutionTimeout: m.resolution_timeout,
    yesPool: m.yes_pool,
    noPool: m.no_pool,
    status: m.status,
    outcome: m.outcome,
    finalizedAt: m.finalized_at,
    createdTx: m.created_tx,
    updatedAt: m.updated_at,
  };
}

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

export const marketRoutes: FastifyPluginAsync = async (app) => {
  app.get("/markets", async (req, reply) => {
    const querySchema = PaginationSchema.extend({
      status: MarketStatusQuerySchema,
    });
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(formatZodError(parsed.error));
    }

    const { limit, cursor, status } = parsed.data;
    const rows = listMarkets(app.db, {
      limit,
      ...(status ? { status } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    });

    const nextCursor =
      rows.length > 0 ? rows[rows.length - 1]!.id : null;

    return reply.send({
      markets: rows.map(serializeMarket),
      nextCursor,
    });
  });

  app.get("/markets/:id", async (req, reply) => {
    const params = z.object({ id: MarketIdSchema }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send(formatZodError(params.error));
    }

    const market = getMarket(app.db, params.data.id);
    if (!market) {
      return reply.status(404).send({ error: "not_found" });
    }
    return reply.send({ market: serializeMarket(market) });
  });

  app.get("/markets/:id/positions", async (req, reply) => {
    const params = z.object({ id: MarketIdSchema }).safeParse(req.params);
    if (!params.success) {
      return reply.status(400).send(formatZodError(params.error));
    }

    const market = getMarket(app.db, params.data.id);
    if (!market) {
      return reply.status(404).send({ error: "not_found" });
    }

    const positions = listMarketPositions(app.db, params.data.id);
    return reply.send({
      marketId: params.data.id,
      positions: positions.map(serializePosition),
    });
  });
};
