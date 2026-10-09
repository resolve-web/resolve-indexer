# Resolve Indexer

Production-oriented Node.js / TypeScript service that indexes **Resolve** Soroban contract events and exposes a read-only HTTP discovery API.

## Important: not authoritative for funds

**This indexer is not the source of truth for balances, claim amounts, or ownership.**

- Use it for market discovery, activity history, and UI listings.
- For claims, payouts, and position amounts that matter for transactions, prefer the Resolve SDK / live Soroban RPC (`get_market`, `get_position`, etc.).
- Indexed pools and positions can lag, miss edge cases, or diverge after reorgs/RPC gaps. Never authorize withdrawals solely from indexer data.

## Stack

| Piece | Choice |
| --- | --- |
| Runtime | Node.js 22+ |
| Language | TypeScript (strict) |
| HTTP | Fastify |
| DB | **SQLite via Node.js built-in `node:sqlite` (`DatabaseSync`)** — zero native addons |
| Migrations | SQL files in `migrations/` applied by `npm run migrate` |
| RPC | `@stellar/stellar-sdk` (`rpc.Server.getEvents`) |
| Validation | zod |
| Logging | pino |

### Why SQLite + `node:sqlite`?

OSS contributors and CI get a working indexer without Postgres or compiling native addons. We use Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) (`DatabaseSync`) — requires **Node.js 22+**. Schema is plain SQL and can be ported to PostgreSQL later; a Postgres adapter is intentionally out of scope for v0 but the migration style (versioned `.sql` files + `schema_migrations`) is compatible with that path.

> Earlier drafts considered `better-sqlite3`; `node:sqlite` avoids native build failures on newer Node versions while keeping the same SQL migrations and sync API shape.

## Events indexed

From the Resolve `#[contractevent]` definitions (topic[0] = snake_case name):

| Event | Topics | Data |
| --- | --- | --- |
| `market_created` | `market_id`, `creator` | `resolver`, `token`, `close_at`, `resolution_timeout` |
| `staked` | `market_id`, `user` | `side`, `amount`, `yes_pool`, `no_pool` |
| `market_resolved` | `market_id`, `resolver` | `outcome` |
| `market_invalidated` | `market_id`, `caller` | — |
| `claimed` | `market_id`, `user` | `amount`, `kind` (`Payout=0`, `Refund=1`) |

Decoding lives in `src/ingest/decoder.ts` and tolerates Map vs Vec data and several enum encodings.

## Quick start

```bash
cp .env.example .env
# set RESOLVE_CONTRACT_ID and SOROBAN_RPC_URL

npm ci
npm run migrate
npm run dev
```

HTTP listens on `PORT` (default `3080`). Ingest polls every `POLL_INTERVAL_MS`.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run migrate` | Apply SQL migrations to `DATABASE_PATH` |
| `npm run dev` | Watch mode (`tsx`) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled `dist/index.js` |
| `npm test` | Unit / API tests (in-memory SQLite) |

## HTTP API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness: `{ status, cursor, lastIngestAt }` |
| `GET` | `/ready` | 200 only after configured ingest has a cursor; otherwise 503 |
| `GET` | `/markets?status=&limit=&cursor=` | Empty DB → `{ markets: [], nextCursor: null }` |
| `GET` | `/markets/:id` | 404 if missing |
| `GET` | `/markets/:id/positions` | |
| `GET` | `/users/:address/positions` | Address validated |
| `GET` | `/users/:address/activity?limit=&cursor=` | |

Errors return JSON `{ error }` without stack traces.

## Ingest behavior

- Polls `getEvents` filtered by `RESOLVE_CONTRACT_ID`.
- Persists a restart-safe cursor in `checkpoints`.
- Skips rows already in `processed_events` (`UNIQUE(tx_hash, event_index)`).
- Retries RPC failures with exponential backoff + jitter.
- Optional `BACKFILL_MARKET_META=true` simulates `get_market` after `market_created` to fill `question` / `description`.

## Configuration

See `.env.example`:

```
STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=
RESOLVE_CONTRACT_ID=
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
DATABASE_PATH=./data/indexer.sqlite
PORT=3080
POLL_INTERVAL_MS=5000
START_LEDGER=
CORS_ORIGINS=http://localhost:3000
```

If RPC URL or contract ID is missing, the process still serves the HTTP API and disables ingest (logged as a warning).
For a public deployment, set `CORS_ORIGINS` to the comma-separated production app origins and use `/ready` for the platform readiness probe.

## Deploy

The repository includes a Node 22 production `Dockerfile` and a `render.yaml` Blueprint with a persistent SQLite disk. The Blueprint is preconfigured for the verified Resolve testnet contract. Update `CORS_ORIGINS` if the app hostname changes, then create the service from the Blueprint. Use `/health` for liveness and `/ready` to confirm that event ingestion has established its first checkpoint.

## Project layout

```
migrations/          SQL migrations
src/
  config.ts
  index.ts           process entry
  server.ts          Fastify app
  db/                SQLite open + migrate + queries
  ingest/            decoder, apply, RPC, worker
  routes/            health, markets, users
tests/               decoder, idempotency, HTTP
```

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
