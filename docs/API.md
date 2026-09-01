# API contract

The stable API base is `/v1/witness`, serving the final WITC protocol. New optional response fields may be added. Existing fields, meanings, and routes require a new API base before incompatible change.

## Error taxonomy

- `400`: malformed path, cursor, query, raw transaction, or validation body
- `401`: missing or invalid admin bearer token
- `404`: indexed object does not exist
- `429`: HTTP or WebSocket rate limit
- `503`: database or authoritative indexer is not ready

Protocol validation responses use the explicit parser or evaluation codes from `src/protocol/types.ts`.

## Pagination

Collection routes accept `limit`, normally 1 through 200, and an opaque `cursor`. Lineage history, address holdings, address activity, invalid events, mempool, search, Circles, and lineages all support bounded continuation. Responses contain a route-specific collection, `limit`, and `nextCursor`. Consumers must not decode or construct cursors. Address holdings returns both `pageValueSats` and the aggregate `totalValueSats`; neither may be parsed through floating-point arithmetic.

## Core routes

`GET /v1/witness/status` returns network, versions, Core and checkpoint heights, lag, state root, mempool counts, and authoritative object counts.

`GET /v1/witness/circles` filters by confirmation state, participant count, context hash, and order. `GET /circles/:txid` returns Circle, members, lineage edges, Bitcoin transaction summary, and live confirmation count.

`GET /v1/witness/transactions/:txid` includes every lineage closure attributed to that transaction, retaining the `canonical` flag for orphan inspection. Address activity combines authoritative Circle participation and ordinary closure events in one deterministic cursor order, so a shard cannot disappear from holdings without a corresponding activity record.

`GET /v1/witness/lineages` filters by status or current script hash. Detail includes the current shard and complete legacy history. The history route preserves its complete response when called without query parameters; supplying `limit` or `cursor` opts into bounded pages of authoritative Circle rows, matching shard rows, and the authoritative closure. An ordinary closure is shown as a closure, never as a transfer.

`GET /v1/witness/graph` accepts an anchor Circle or lineage and enforces depth and 1,000-node bounds.

`POST /v1/witness/validate` accepts `{ "rawHex": "..." }`. It is read-only and returns WITC evaluation plus Bitcoin Core `testmempoolaccept`. The caller must treat both results as untrusted until independently verified.

`POST /v1/witness/safety/outpoints` accepts 1 through 200 unique lowercase `{ "txid", "vout" }` objects. The response is never cacheable. The server brackets one stable Bitcoin Core tip and mempool sequence, requires exact Core-to-database active-mempool parity and a fresh successful reconciliation, then classifies every requested outpoint as `active-shard`, `pending-successor`, `pending-spend`, `unconfirmed`, or `unclassified`. Signing clients must require `complete: true`, exact item ordering, and an unchanged snapshot hash. Any error, truncation, unknown field, or unexpected classification is a fail-closed result.

## WebSocket

Connect to Socket.IO namespace `/v1/witness/ws` using WebSocket transport. Broadcast events:

- `block`
- `circle`
- `mempool`
- `replacement`
- `reorg`
- `lineage.closed`

Send `subscribe` with a valid `circleTxid` or `lineageId` for scoped rooms. Connection, message, payload, and room limits come from security configuration.

## Deliberate omissions

There are no transfer, marketplace, collection-price, ownership-sale, or wealth-ranking routes. Address holdings means active same-key successor shards, not transferable protocol assets and not proof of identity.
