# Contributing to Resolve Indexer

Thanks for helping improve the Resolve indexer.

## Development

1. Use Node.js 22+.
2. `npm ci`
3. `cp .env.example .env` and set at least `RESOLVE_CONTRACT_ID` / `SOROBAN_RPC_URL` for live ingest.
4. `npm run migrate`
5. `npm test` and `npm run build` before opening a PR.

## Guidelines

- Keep TypeScript `strict` clean; avoid `any` unless unavoidable at SDK boundaries.
- Prefer extending `src/ingest/decoder.ts` + unit tests when on-chain encoding differs from fixtures.
- Do not add fake market seed data to the API — empty DB must return empty lists.
- Remember: the indexer is **not** authoritative for payouts; do not document it as such.
- Match existing file layout (`db/`, `ingest/`, `routes/`).

## Pull requests

- Include a short description of behavior change and how you tested it.
- Keep diffs focused; avoid unrelated formatting churn.
- CI must pass (`lint` via `typecheck`, `test`, `build`).

## Reporting security issues

See [SECURITY.md](./SECURITY.md).
