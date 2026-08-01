# API contract

API version `v1` is stable within WITC protocol version 1. New optional response fields may be added. Existing fields, meanings, and routes require a new API version before incompatible change.

## Error taxonomy

- `400`: malformed path, cursor, query, raw transaction, or validation body
- `401`: missing or invalid admin bearer token
- `404`: indexed object does not exist
- `429`: HTTP or WebSocket rate limit
- `503`: database or canonical indexer is not ready

Protocol validation responses use the explicit parser or evaluation codes from `src/protocol/types.ts`.

## Pagination

Collection routes accept `limit`, normally 1 through 200, and an opaque `cursor`. Responses contain `items`, `limit`, and `nextCursor`. Consumers must not decode or construct cursors.

## Core routes

`GET /v1/witness/status` returns network, versions, Core and checkpoint heights, lag, state root, mempool counts, and canonical object counts.

`GET /v1/witness/circles` filters by confirmation state, participant count, context hash, and order. `GET /circles/:txid` returns Circle, members, lineage edges, Bitcoin transaction summary, and live confirmation count.

`GET /v1/witness/lineages` filters by status or current script hash. Detail includes the current shard and full canonical history. An ordinary closure is shown as a closure, never as a transfer.

`GET /v1/witness/graph` accepts an anchor Circle or lineage and enforces depth and 1,000-node bounds.

`POST /v1/witness/validate` accepts `{ "rawHex": "..." }`. It is read-only and returns WITC evaluation plus Bitcoin Core `testmempoolaccept`. The caller must treat both results as untrusted until independently verified.

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
