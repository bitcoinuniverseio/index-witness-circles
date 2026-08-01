import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canonicalStateRoot,
  type CanonicalWitnessStateSnapshot,
  computeCanonicalStateRoot,
  EMPTY_WITNESS_STATE,
  EMPTY_STATE_ROOT,
  type StateRootReader,
} from '../src/indexer/state-root';

const CIRCLE_TXID = '3703d5b332ebf2871a0a24066f7ea4b84dd3e9ebca1b1a879140e844c64b0f65';
const LINEAGES = [
  '4bc0f5c804bffee98f9d5239c11d6b9ed7473af856c6f9709763cb44276f5617',
  '63c22eae014513dbabfffe84db6131635ce44e066156be0a396b9db4f2dc18b7',
  'ee745631e7bea77a35e38ed050e495c0a5eafca41cef5dd59ce7243b5aceacdb',
];
const INPUT_TXIDS = ['11'.repeat(32), '22'.repeat(32), '33'.repeat(32)];
const SCRIPTS = [
  '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
  '5120c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
  '5120f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
];
const CONTINUATION_TXID = 'f7c7ecb3be4ee1925fc97111afde797633de0fae797d0a12383aecb6868328ef';
const CLOSING_TXID = 'dd'.repeat(32);

interface LifecycleVector {
  genesis: { expectedStateHash: string };
  continuation: { expectedStateHash: string };
  closure: { expectedStateHash: string };
  rollbackExpectedStateHashes: string[];
}

function item<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing fixture item ${index}`);
  return value;
}

function freshSnapshot(): CanonicalWitnessStateSnapshot {
  const inputValues = ['30000', '40000', '50000'];
  const outputValues = ['28790', '38790', '48790'];
  return {
    protocol: 'witc',
    version: 1,
    revision: 1,
    lineages: LINEAGES.map((lineageId, slot) => ({
      lineageId,
      genesisOutpoint: `${item(INPUT_TXIDS, slot)}:${slot}`,
      currentOutpoint: `${CIRCLE_TXID}:${slot + 1}`,
      status: 'active',
      firstHeight: 200,
      lastHeight: 200,
      circleCount: 1,
      closedByTxid: null,
    })),
    shards: LINEAGES.map((lineageId, slot) => ({
      outpoint: `${CIRCLE_TXID}:${slot + 1}`,
      lineageId,
      scriptPubKey: item(SCRIPTS, slot),
      valueSats: item(outputValues, slot),
      createdByCircle: CIRCLE_TXID,
      previousOutpoint: `${item(INPUT_TXIDS, slot)}:${slot}`,
      createdHeight: 200,
      spentByTxid: null,
      spentHeight: null,
    })),
    circles: [
      {
        txid: CIRCLE_TXID,
        wtxid: '772b6d1d179e6f5ba1c4699486a754ef7681b6299ee0e023fc2a5dd0c11245ab',
        contextHash: 'ad2608134839e732280cb93bdd5b8682626dce5748a65c437a39cdcb680c2a82',
        participantCount: 3,
        feeSats: '3630',
        blockHeight: 200,
        blockHash: 'aa'.repeat(32),
        transactionIndex: 4,
        members: LINEAGES.map((lineageId, slot) => ({
          slot,
          lineageId,
          inputOutpoint: `${item(INPUT_TXIDS, slot)}:${slot}`,
          outputOutpoint: `${CIRCLE_TXID}:${slot + 1}`,
          inputValueSats: item(inputValues, slot),
          outputValueSats: item(outputValues, slot),
          feeShareSats: '1210',
          wasExistingLineage: false,
        })),
      },
    ],
    edges: [],
  };
}

function continuationSnapshot(): CanonicalWitnessStateSnapshot {
  const snapshot = structuredClone(freshSnapshot());
  snapshot.revision = 2;
  const continuationValues = ['28132', '38133'];
  const feeShares = ['658', '657'];
  for (let slot = 0; slot < 2; slot += 1) {
    const lineage = item(snapshot.lineages, slot);
    snapshot.lineages[slot] = {
      ...lineage,
      currentOutpoint: `${CONTINUATION_TXID}:${slot + 1}`,
      lastHeight: 201,
      circleCount: 2,
    };
    const predecessor = item(snapshot.shards, slot);
    snapshot.shards[slot] = {
      ...predecessor,
      spentByTxid: CONTINUATION_TXID,
      spentHeight: 201,
    };
    snapshot.shards.push({
      outpoint: `${CONTINUATION_TXID}:${slot + 1}`,
      lineageId: item(LINEAGES, slot),
      scriptPubKey: item(SCRIPTS, slot),
      valueSats: item(continuationValues, slot),
      createdByCircle: CONTINUATION_TXID,
      previousOutpoint: `${CIRCLE_TXID}:${slot + 1}`,
      createdHeight: 201,
      spentByTxid: null,
      spentHeight: null,
    });
  }
  snapshot.circles.push({
    txid: CONTINUATION_TXID,
    wtxid: 'af2764537d4701d9255777c41fa20aeebd5f1f9884144b8a11b1940a692b7121',
    contextHash: '656d9e373df39d531f209ea24d8c90ebd7566b0f995444bd2d1b932a0427ab6e',
    participantCount: 2,
    feeSats: '1315',
    blockHeight: 201,
    blockHash: 'bb'.repeat(32),
    transactionIndex: 1,
    members: [0, 1].map((slot) => ({
      slot,
      lineageId: item(LINEAGES, slot),
      inputOutpoint: `${CIRCLE_TXID}:${slot + 1}`,
      outputOutpoint: `${CONTINUATION_TXID}:${slot + 1}`,
      inputValueSats: item(['28790', '38790'], slot),
      outputValueSats: item(continuationValues, slot),
      feeShareSats: item(feeShares, slot),
      wasExistingLineage: true,
    })),
  });
  snapshot.edges.push(
    ...[0, 1].map((slot) => ({
      fromCircle: CIRCLE_TXID,
      toCircle: CONTINUATION_TXID,
      lineageId: item(LINEAGES, slot),
      viaOutpoint: `${CIRCLE_TXID}:${slot + 1}`,
    })),
  );
  return snapshot;
}

function closureSnapshot(): CanonicalWitnessStateSnapshot {
  const snapshot = structuredClone(continuationSnapshot());
  snapshot.revision = 3;
  const lineage = item(snapshot.lineages, 0);
  snapshot.lineages[0] = {
    ...lineage,
    currentOutpoint: null,
    status: 'closed',
    lastHeight: 202,
    closedByTxid: CLOSING_TXID,
  };
  const shard = snapshot.shards.find(({ outpoint }) => outpoint === `${CONTINUATION_TXID}:1`);
  if (!shard) throw new Error('Missing lifecycle closure shard');
  shard.spentByTxid = CLOSING_TXID;
  shard.spentHeight = 202;
  return snapshot;
}

describe('canonical state root', () => {
  it('matches the canonical empty snapshot hash', () => {
    expect(EMPTY_STATE_ROOT).toBe(
      '90e749b7720fac379610d979e29998c7d650150548622f0a47d9d3e181f1be52',
    );
  });

  it('reproduces the published first-Circle state hash from database projections', async () => {
    const inputValues = [30_000, 40_000, 50_000];
    const outputValues = [28_790, 38_790, 48_790];
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ revision: '1' }])
      .mockResolvedValueOnce([
        {
          txid: CIRCLE_TXID,
          wtxid: '772b6d1d179e6f5ba1c4699486a754ef7681b6299ee0e023fc2a5dd0c11245ab',
          contextHash: 'ad2608134839e732280cb93bdd5b8682626dce5748a65c437a39cdcb680c2a82',
          participantCount: 3,
          feeSats: '3630',
          blockHeight: 200,
          blockHash: 'aa'.repeat(32),
          transactionIndex: 4,
        },
      ])
      .mockResolvedValueOnce(
        LINEAGES.map((lineageId, slot) => ({
          txid: CIRCLE_TXID,
          slot,
          lineageId,
          inputTxid: INPUT_TXIDS[slot],
          inputVout: slot,
          inputValueSats: String(inputValues[slot]),
          outputVout: slot + 1,
          outputValueSats: String(outputValues[slot]),
          feeShareSats: '1210',
          fresh: 1,
        })),
      )
      .mockResolvedValueOnce(
        LINEAGES.map((lineageId, slot) => ({
          lineageId,
          genesisTxid: INPUT_TXIDS[slot],
          genesisVout: slot,
          currentTxid: CIRCLE_TXID,
          currentVout: slot + 1,
          status: 'active',
          firstHeight: 200,
          lastHeight: 200,
          circleCount: 1,
          closedByTxid: null,
        })),
      )
      .mockResolvedValueOnce(
        LINEAGES.map((lineageId, slot) => ({
          txid: CIRCLE_TXID,
          vout: slot + 1,
          lineageId,
          valueSats: String(outputValues[slot]),
          scriptPubKey: SCRIPTS[slot],
          createdByCircle: CIRCLE_TXID,
          createdHeight: 200,
          previousTxid: INPUT_TXIDS[slot],
          previousVout: slot,
          spentByTxid: null,
          spentHeight: null,
        })),
      )
      .mockResolvedValueOnce([]);
    const reader = { query } as StateRootReader;

    await expect(computeCanonicalStateRoot(reader)).resolves.toBe(
      '07b97f0c2cbaa172e66a2137fefbee64c5a05f03e03967d46936cd14070523f1',
    );
    expect(String(query.mock.calls[4]?.[0])).toContain('COALESCE(s.previous_txid, m.input_txid)');
  });

  it('reproduces the published continuation, closure, and rollback lifecycle roots', () => {
    const vector = JSON.parse(
      readFileSync(resolve('test-vectors/v1/state-lifecycle.json'), 'utf8'),
    ) as LifecycleVector;
    const fresh = freshSnapshot();
    const continuation = continuationSnapshot();
    const closure = closureSnapshot();

    expect(canonicalStateRoot(fresh)).toBe(vector.genesis.expectedStateHash);
    expect(canonicalStateRoot(continuation)).toBe(vector.continuation.expectedStateHash);
    expect(canonicalStateRoot(closure)).toBe(vector.closure.expectedStateHash);
    expect([
      canonicalStateRoot(continuation),
      canonicalStateRoot(fresh),
      canonicalStateRoot(EMPTY_WITNESS_STATE),
    ]).toEqual(vector.rollbackExpectedStateHashes);
  });

  it('rejects unsafe integers, oversized vouts, and amounts above MAX_MONEY', () => {
    const fresh = freshSnapshot();
    expect(() => canonicalStateRoot({ ...fresh, revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      /safe integer/,
    );
    const firstShard = item(fresh.shards, 0);
    expect(() =>
      canonicalStateRoot({
        ...fresh,
        shards: [{ ...firstShard, outpoint: `${'aa'.repeat(32)}:4294967296` }],
      }),
    ).toThrow(/uint32 outpoint/);
    expect(() =>
      canonicalStateRoot({
        ...fresh,
        shards: [{ ...firstShard, valueSats: '2100000000000001' }],
      }),
    ).toThrow(/money range/);
  });
});
