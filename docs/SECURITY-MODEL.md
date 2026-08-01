# Security model

## Fund safety

The indexer never signs, broadcasts, selects coins, or holds keys. It rejects unsafe sighash shapes and successor mismatches as protocol-invalid, but only Bitcoin Core verifies the actual Schnorr signature. Wallets must independently decode every prevout, input, output, fee, marker, context hash, and sighash before signing.

## Parser safety

- Exact direct push and byte count
- No alternate operation in v1
- Checked bigint amount arithmetic
- Deterministic ordering and fee remainder
- Explicit future-version observation without interpretation
- Metadata excluded from protocol state
- Parser version recorded per block and invalid event
- Golden and malformed fixtures plus arbitrary-byte scanning

## State safety

- Best-chain block order only
- One fenced leader
- Serial checkpoint lock
- Whole-block atomic transaction
- Idempotent primary keys and upserts
- Pre-block undo snapshots
- Root verification during rollback
- Core hash cross-check and deterministic replay

## Service safety

- Strong production configuration validation
- Admin bearer keys compared by fixed-length digests
- Global REST throttling and stricter admin throttling
- WebSocket connection, per-IP, message, payload, and room limits
- Query, graph, page, validation-body, and verification-range bounds
- Helmet headers and restrictive API documentation CSP
- CORS deny by default
- Structured log redaction
- No cookies, sessions, private keys, or signing secrets
- Controlled migrations and dependency audit in CI

## Residual risks

- A compromised Bitcoin Core node can present a false local chain view.
- A compromised primary database can alter indexed state until state-root and Core checks detect it.
- Read replicas can be stale.
- Address and script reuse publicly link activity by protocol design.
- Optional metadata consumers must sanitize it independently.
- Source and parser agreement does not prove protocol novelty or user identity.
