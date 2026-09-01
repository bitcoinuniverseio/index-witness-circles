# Operations

## Deployment order

1. Back up and verify the primary database.
2. Deploy the new application image without starting public traffic.
3. Run `node dist/database/migrate.js` once.
4. Start one indexer instance and verify `/ready`, `/metrics`, and Core network match.
5. Start standby and API instances.
6. Compare `verify` and `verify-core` results.
7. Enable public traffic.

The application never runs pending migrations automatically.

## Authoritative state-root activation

Migration `HardenWitnessState1796083201000` activates the specification-defined state root. Legacy checkpoint and undo roots cannot be converted safely, so the migration deletes only chain-derived projections, resets the checkpoint to the configured boundary, and marks it `reindexing`. It preserves configuration, migration history, parser and indexer version records, leases, metadata references, and admin audit jobs.

This migration requires a complete replay from `INDEXER_START_HEIGHT`. Keep public traffic disabled until replay reaches the exact Core tip, `/ready` succeeds, and both `verify` and `verify-core` pass. The migration is operationally irreversible because deleted projections can only be recovered from a backup or rebuilt from Bitcoin Core.

## Backups

Back up MySQL with transactionally consistent snapshots and binlogs. Chain-derived state has a logical recovery point of zero because it can be replayed, but restoration time can be substantial. Keep configuration, migration history, parser revision, activation boundary, and Core block data with the backup record.

Test a restore at least monthly:

1. Restore to an isolated database.
2. Start the same source and parser revision with indexing disabled.
3. Run `verify`.
4. Run `verify-core` across the restored boundary and tip.
5. Replay a recent block range and compare the final state root.

## Reindexing

`repair` rebuilds only nonauthoritative search and statistics. It cannot repair protocol state.

`reindex H` rolls back through H-1 and replays to Core tip. `reindex-range A B` proves the selected range can be replayed, then continues to Core tip. Both require the writer lease and create an auditable admin job row.

Never run two repair or reindex operations concurrently. Read APIs may remain available but readiness becomes false during replay.

## Reorganizations

The coordinator compares its checkpoint hash to Core before forward sync. It reads Core's current height first, so a temporarily shorter Core tip rolls local blocks back without requesting unavailable heights. On mismatch it finds the common ancestor, records a reorganization, applies each undo document in reverse order, verifies each previous root, then replays the new branch.

Block projection, checkpoint advancement, and confirmation of matching local mempool rows share one fenced database transaction. A crash therefore cannot commit a confirmed block while leaving the same transaction active in the mempool projection.

If an undo record is absent or a root differs, indexing stops. Do not bypass this check. Restore a verified backup or replay from a known-good boundary.

## Alerting

Load `deploy/prometheus-alerts.yml`. Page on readiness loss, stale block progress, deep reorganization, repeated invalid-marker spikes, API error rate, or process restarts. Investigate node availability, lease state, database replication, state roots, disk, and RPC latency before restarting.

## Graceful shutdown

Nest shutdown hooks close ZMQ sockets and release the lease. Container orchestrators should allow at least 30 seconds. If an instance is killed, its transaction rolls back and the lease expires after `INDEXER_LEASE_TTL_MS`.

## Retention

Authoritative Bitcoin and WITC facts, invalid confirmed markers, undo records, reorgs, checkpoints, and admin audit jobs are retained. Terminal mempool observations are removed after `MEMPOOL_RETENTION_DAYS`. Backups and logs need an organization-approved retention policy before production.
