# Witness Circles Indexer

`index-witness-circles` is the independent Bitcoin Core indexer and public read API for the finalized Witness Circles `WITC` protocol.

It derives all canonical protocol state from Bitcoin blocks. It does not trust manifests, frontends, coordinators, social profiles, or marketplace services. WITC supports only `CIRCLE`. It has no transfer, marketplace, token, mint, or `REFUEL` operation.

## What it implements

- Strict 42-byte `OP_RETURN PUSH40` marker detection
- Complete transaction, fee-share, Taproot witness-shape, successor, and lineage validation
- Confirmed block ingestion through Bitcoin Core RPC
- ZMQ `hashblock`, `rawtx`, and `sequence` notifications with polling fallback
- Explicitly provisional local mempool state
- RBF replacement and shared-input conflict tracking
- Atomic block commits protected by a database fencing lease
- Undo-backed reorganization rollback with state-root verification
- Historical sync, full replay, partial range replay, repair, and Core cross-check commands
- Normalized MySQL 8 schema and controlled migrations
- REST, Socket.IO, runtime OpenAPI, cursor pagination, filtering, and rate limiting
- Prometheus metrics, JSON logs, liveness, readiness, and alert rules
- Optional TypeORM read replicas for public queries

## Quick start

Requirements:

- Node.js 24.19.0 and npm 11.17.0
- MySQL 8.0 or newer
- Bitcoin Core with RPC and ZMQ enabled
- `txindex=1` for reliable historical prevout hydration
- An unpruned node when indexing below the node's prune height

```powershell
Copy-Item .env.example .env
npm ci
npm run migration:run
npm run start:dev
```

The default HTTP port is `3012`.

- API: `http://127.0.0.1:3012/v1/witness/status`
- OpenAPI UI: `http://127.0.0.1:3012/docs`
- OpenAPI JSON: `http://127.0.0.1:3012/docs-json`
- Socket.IO namespace: `/v1/witness/ws`
- Liveness: `/health`
- Readiness: `/ready`
- Prometheus: `/metrics`

Run migrations as a controlled one-shot step before starting any application instance. The service refuses to start when migrations are pending.

## Bitcoin Core configuration

Regtest example:

```ini
server=1
txindex=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
zmqpubhashblock=tcp://127.0.0.1:28332
zmqpubrawtx=tcp://127.0.0.1:28333
zmqpubsequence=tcp://127.0.0.1:28334
```

Never expose Bitcoin RPC to the public internet. Use unique strong RPC and database credentials in every deployed environment.

## Network and indexing boundary

`WITNESS_NETWORK` must be `signet` or `regtest`. The parser can classify all four assigned protocol network bytes for deterministic observation, but this release fails startup for mainnet and testnet3 deployments.

`INDEXER_START_HEIGHT` is a trust boundary. A deployment starting above zero can verify and continue WITC lineages created after that height, but it cannot discover earlier protocol history without replaying from an earlier boundary. Public canonical deployments should use the protocol activation height once that height is assigned.

The indexer follows the node's best chain at one confirmation. `INDEXER_CONFIRMATIONS` is the display threshold for a settled Circle and does not delay canonical indexing.

## Commands

```powershell
npm run cli -- verify
npm run cli -- verify-core 0 999
npm run cli -- sync
npm run cli -- repair
npm run cli -- reindex 0
npm run cli -- reindex-range 1000 2000
```

The same commands are available under `/v1/witness/admin` and require a bearer token from `ADMIN_API_KEYS`. Range replay rolls back to the preceding height, replays the requested range, then restores canonical state through the current Core tip.

## Stable REST paths

Read API base: `/v1/witness`

- `GET /status`
- `GET /circles` and `GET /circles/:txid`
- `GET /transactions/:txid`
- `GET /lineages`, `GET /lineages/:lineageId`, and `GET /lineages/:lineageId/history`
- `GET /shards/:txid/:vout`
- `GET /addresses/:address/holdings` and `/activity`
- `GET /graph`
- `GET /mempool` and `GET /mempool/:txid`
- `GET /invalid-events` and `GET /invalid-events/:txid`
- `GET /search`, `/trending`, `/stats`, and `/fees`
- `POST /safety/outpoints`
- `POST /validate`

Bitcoin satoshi amounts are serialized as decimal strings when the database or TypeScript value is wider than safe JSON integers. Consumers must not parse them through floating-point arithmetic.

## Horizontal operation

Multiple instances may share one primary database. Exactly one instance holds the canonical-ingester lease. The fencing token is checked inside every state-changing database transaction. Standby instances continue serving reads and attempt leadership after lease expiry.

Set `MYSQL_READ_HOSTS` to a comma-separated host list to enable TypeORM query replicas. Canonical ingestion, migrations, lease changes, checkpoints, and repair work always target the primary. Read replicas may be briefly stale and must never drive validation or signing decisions.

## Validation boundary

The parser verifies the protocol grammar and state rules. Bitcoin Core verifies actual Schnorr signatures, scripts, amounts, and consensus validity for confirmed and mempool transactions. `POST /validate` returns both the WITC evaluation and `testmempoolaccept` policy result. A WITC-valid classification alone is not permission to broadcast or sign.

Optional context manifests are identified only by their SHA-256 hash. `wc_metadata_references` is deliberately untrusted for protocol correctness and the indexer never fetches metadata automatically.

`POST /safety/outpoints` is a no-store signing-safety proof. It brackets Bitcoin Core chain and mempool sequence state, requires exact checkpoint and active-mempool parity, and classifies every requested outpoint at that checkpoint. Wallets must fail closed unless the complete response and all required classifications match the transaction being reviewed.

## Quality checks

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

See [Protocol rules](docs/PROTOCOL.md), [architecture](docs/ARCHITECTURE.md), [API contract](docs/API.md), [operations](docs/OPERATIONS.md), [security](docs/SECURITY-MODEL.md), and [implementation deviations](docs/DEVIATIONS.md).
