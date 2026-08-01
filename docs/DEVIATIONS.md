# Material implementation decisions

The implementation preserves the selected final WITC protocol design with these explicit resolutions:

1. The previously underspecified lineage outpoint encoding is standard Bitcoin wire serialization: reversed display txid bytes and little-endian uint32 vout, preceded by the exact ASCII domain tag.
2. `REFUEL` remains reserved and is invalid in the protocol. No placeholder branch or API exists for it.
3. CPFP is not modeled as a WITC operation. Arbitrary child transactions remain ordinary Bitcoin behavior.
4. The indexer follows the Core best chain immediately. The configurable confirmation count is a settled-display threshold, not a delay in canonical state.
5. MySQL 8 is used to match proven Bitcoin Universe indexer infrastructure. MySQL has no partial indexes, so status-first composite indexes and single-writer application invariants replace proposed partial indexes.
6. Optional metadata references have a hard database check that they are never trusted for protocol validity. The indexer does not fetch manifests.
7. Orphan Circle facts and members remain inspectable, while derived orphan lineages and shards are removed by undo. Canonical API queries exclude them unless orphan status is requested.
8. Rankings are omitted. The selected design prohibits wealth, volume, marketplace, and transfer incentives. Trending is a transparent recent context aggregation only.
9. Signature bytes are shape-checked by the parser. Cryptographic verification is delegated to Bitcoin Core consensus and mempool validation, with `testmempoolaccept` returned separately for raw validation.
