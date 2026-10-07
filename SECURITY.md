# Security Policy

## Not a custody or payout authority

Resolve Indexer stores a derived view of on-chain events for discovery and history. It must not be treated as authoritative for balances, claim eligibility, or ownership. Applications should verify claim/payout amounts against the Soroban contract via RPC or the official SDK before submitting transactions.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/resolve-web/resolve-indexer/security/advisories/new).

Include:

- Affected component (API route, ingest path, decoder, etc.)
- Reproduction steps or proof of concept
- Impact assessment (data integrity, DoS, info disclosure)

Do not open a public issue for exploitable vulnerabilities until a fix is available.

## Scope notes

- Stack traces must never be returned from the HTTP API.
- Database files under `data/` may contain indexed addresses and activity — treat deployments as sensitive operational data.
- RPC credentials / `.env` must not be committed.
