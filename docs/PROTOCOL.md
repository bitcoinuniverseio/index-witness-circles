# WITC protocol rules

This document states the rules enforced by this indexer. The public protocol repository remains the eventual normative publication location.

## Marker

Output zero must be zero satoshis and contain exactly:

```text
OP_RETURN PUSH40
57 49 54 43 | 01 | network | 01 | participant_count | context_hash[32]
```

- Magic: ASCII `WITC`
- Version: `1`
- Networks: mainnet `0`, testnet3 `1`, Signet `2`, regtest `3`
- Operation: `1 CIRCLE`
- Participants: 2 through 16
- Context hash: nonzero SHA-256 digest
- Script length: exactly 42 bytes
- Alternate push encodings and trailing bytes are invalid

Unknown protocol versions are observed but never interpreted by this indexer. Unknown operations, including `REFUEL`, are invalid.

## Transaction

- Version 2
- Locktime 0
- Exactly N inputs and N+1 outputs
- Every input sequence is `0xfffffffd`
- Every input references a confirmed native P2TR output from a lower block height
- Input outpoints are unique and sorted by lowercase display txid bytes, then numeric vout
- Input P2TR scripts are distinct
- Every witness contains exactly one 64-byte `SIGHASH_DEFAULT` signature or a 65-byte signature ending in `01` for `SIGHASH_ALL`
- Script path, annex, `ANYONECANPAY`, `NONE`, and `SINGLE` are invalid
- Output i+1 repeats input i's script exactly
- No other spendable output exists
- Every successor contains at least 1,000 sats

## Fee shares

```text
F = sum(inputs) - sum(successors)
q = floor(F / N)
r = F mod N
share(i) = q + 1 when i < r, otherwise q
successor(i) = input(i) - share(i)
```

The sorted earliest slots pay the remainder. The indexer rejects any other allocation.

## Lineages

Fresh lineage identifiers use:

```text
SHA256(
  ASCII("WITC/lineage/v1") ||
  reverse(display_txid_bytes) ||
  uint32le(vout)
)
```

The outpoint portion is standard Bitcoin wire serialization. A valid Circle creates one same-script successor shard per participant. A later Circle may spend the active shard and create its next successor. A lineage can occur only once in a Circle.

Any confirmed spend of an active shard that does not satisfy the protocol rules closes the lineage. This includes ordinary transactions, malformed WITC candidates, and unknown future protocol versions. The bitcoin is not burned. The historical lineage remains readable. There is no WITC transfer or rekey operation.

## Chain and mempool

The best Bitcoin chain defines canonical state. Pending observations are local to one node and never mutate canonical lineages. Replacement requires a new transaction and signatures. On a reorganization, the indexer restores the exact pre-block snapshots and verifies the previous state root before replay.

Context metadata is optional and cannot affect parsing, validity, ownership, ordering, fees, or state.
