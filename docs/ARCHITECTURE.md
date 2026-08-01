# Architecture

```text
Bitcoin Core RPC and ZMQ
        |
        v
raw transaction normalization
        |
        v
strict marker parser and state evaluator
        |
        v
fenced atomic MySQL block transaction
        |
        +--> normalized canonical state and undo record
        +--> local mempool projection and conflict graph
        +--> checkpoint and deterministic state root
        |
        v
REST, Socket.IO, OpenAPI, metrics, health, and admin tools
```

## Trust boundaries

Bitcoin Core is the consensus and policy verifier. MySQL is a reproducible projection. The parser is deterministic and does not make network requests. Optional metadata is untrusted. Public API input can select or validate data but cannot mutate canonical state.

The canonical writer lease uses a database row, expiry, monotonically increasing fencing token, and `FOR UPDATE` check inside each state mutation. This prevents a paused former leader from committing after a replacement leader acquires the lease.

## Atomicity and recovery

One database transaction covers every transaction in a Bitcoin block, protocol transitions, ordinary lineage closures, output spent markers, state root, undo document, statistics, and checkpoint. A crash commits all of the block or none of it.

The undo document stores each preexisting lineage, shard, and output row before first modification plus identifiers created by the block. Rollback restores those rows, marks block facts orphaned, restores the checkpoint, recomputes the state root, and aborts if roots disagree.

## Determinism

The state root hashes ordered canonical Circle facts, member facts, current lineage state, all shard state, and canonical closures. The hash excludes API cache, manifests, profiles, timestamps created by the database, mempool data, search text, and statistics.

`verify` recomputes the root. `verify-core` compares canonical block hashes to Core. Range replay restores the tail after repairing the requested range, so partial repair cannot leave the database at an arbitrary historical state.

## Scaling

The canonical writer is intentionally single-leader because block order is serial. API instances and optional read replicas scale horizontally. Block writes use normalized rows and composite indexes. Graph queries have explicit depth and node limits. REST collections use cursors. Mempool terminal records have configurable retention.
