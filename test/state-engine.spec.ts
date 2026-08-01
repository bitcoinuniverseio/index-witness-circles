import {
  WitnessNetwork,
  WitnessStateEngine,
  deriveLineageId,
  encodeWitnessScript,
} from '../src/protocol';
import {
  CIRCLE_TXID,
  CONTEXT_HASH,
  MemoryLookup,
  SCRIPT_A,
  SCRIPT_B,
  TXID_A,
  TXID_B,
  circleTransaction,
  deepCopyTransaction,
} from './fixtures';

describe('WitnessStateEngine', () => {
  const engine = new WitnessStateEngine();

  async function evaluate(transaction = circleTransaction(), lookup = new MemoryLookup()) {
    return engine.evaluate(transaction, {
      network: WitnessNetwork.REGTEST,
      blockHeight: 2,
      confirmed: true,
      lookup,
    });
  }

  it('accepts a canonical two-participant fresh Circle and allocates the fee remainder', async () => {
    const result = await evaluate();
    expect(result.classification).toBe('valid');
    if (result.classification !== 'valid') return;
    expect(result.transition.feeSats).toBe(2_631n);
    expect(result.transition.members.map(({ feeShareSats }) => feeShareSats)).toEqual([
      1_316n,
      1_315n,
    ]);
    expect(result.transition.members.every(({ fresh }) => fresh)).toBe(true);
    expect(result.transition.members[0]?.lineageId).toBe(
      deriveLineageId({ txid: TXID_A, vout: 0 }),
    );
  });

  it('continues active lineages and records previous Circles', async () => {
    const transaction = circleTransaction();
    const lookup = new MemoryLookup();
    const lineageA = 'a1'.repeat(32);
    const lineageB = 'b1'.repeat(32);
    lookup.addActiveShard(TXID_A, 0, lineageA, SCRIPT_A, 30_000n, 'c1'.repeat(32));
    lookup.addActiveShard(TXID_B, 1, lineageB, SCRIPT_B, 40_000n, 'c2'.repeat(32));
    const result = await evaluate(transaction, lookup);
    expect(result).toMatchObject({ classification: 'valid' });
    if (result.classification !== 'valid') return;
    expect(result.transition.members.map(({ lineageId }) => lineageId)).toEqual([
      lineageA,
      lineageB,
    ]);
    expect(result.transition.members.map(({ previousCircleTxid }) => previousCircleTxid)).toEqual([
      'c1'.repeat(32),
      'c2'.repeat(32),
    ]);
  });

  it.each([
    ['TRANSACTION_VERSION', (tx: ReturnType<typeof circleTransaction>) => (tx.version = 1)],
    ['LOCKTIME_MISMATCH', (tx: ReturnType<typeof circleTransaction>) => (tx.locktime = 1)],
    [
      'SEQUENCE_MISMATCH',
      (tx: ReturnType<typeof circleTransaction>) => (tx.inputs[0]!.sequence = 0xffff_ffff),
    ],
    ['PARTICIPANT_COUNT_MISMATCH', (tx: ReturnType<typeof circleTransaction>) => tx.inputs.pop()],
    [
      'OUTPUT_COUNT_MISMATCH',
      (tx: ReturnType<typeof circleTransaction>) =>
        tx.outputs.push({ valueSats: 1_000n, scriptPubKeyHex: SCRIPT_A }),
    ],
    ['MARKER_VALUE', (tx: ReturnType<typeof circleTransaction>) => (tx.outputs[0]!.valueSats = 1n)],
    ['MISSING_PREVOUT', (tx: ReturnType<typeof circleTransaction>) => delete tx.inputs[0]!.prevout],
    [
      'UNCONFIRMED_PREVOUT',
      (tx: ReturnType<typeof circleTransaction>) => delete tx.inputs[0]!.prevout!.blockHeight,
    ],
    [
      'SAME_BLOCK_PREVOUT',
      (tx: ReturnType<typeof circleTransaction>) => (tx.inputs[0]!.prevout!.blockHeight = 2),
    ],
    [
      'NON_P2TR_PREVOUT',
      (tx: ReturnType<typeof circleTransaction>) =>
        (tx.inputs[0]!.prevout!.scriptPubKeyHex = '0014' + 'aa'.repeat(20)),
    ],
    [
      'DUPLICATE_OUTPOINT',
      (tx: ReturnType<typeof circleTransaction>) => {
        tx.inputs[1]!.txid = tx.inputs[0]!.txid!;
        tx.inputs[1]!.vout = tx.inputs[0]!.vout!;
      },
    ],
    [
      'DUPLICATE_SCRIPT',
      (tx: ReturnType<typeof circleTransaction>) =>
        (tx.inputs[1]!.prevout!.scriptPubKeyHex = SCRIPT_A),
    ],
    ['INPUT_ORDER', (tx: ReturnType<typeof circleTransaction>) => tx.inputs.reverse()],
    [
      'INVALID_SIGHASH',
      (tx: ReturnType<typeof circleTransaction>) => (tx.inputs[0]!.witness = ['00'.repeat(65)]),
    ],
    [
      'NEGATIVE_FEE',
      (tx: ReturnType<typeof circleTransaction>) => (tx.outputs[1]!.valueSats = 100_000n),
    ],
    [
      'SUCCESSOR_SCRIPT_MISMATCH',
      (tx: ReturnType<typeof circleTransaction>) => (tx.outputs[1]!.scriptPubKeyHex = SCRIPT_B),
    ],
    [
      'SUCCESSOR_VALUE_MISMATCH',
      (tx: ReturnType<typeof circleTransaction>) => {
        tx.outputs[1]!.valueSats += 1n;
        tx.outputs[2]!.valueSats -= 1n;
      },
    ],
    [
      'SUCCESSOR_BELOW_MINIMUM',
      (tx: ReturnType<typeof circleTransaction>) => {
        tx.inputs[0]!.prevout!.valueSats = 2_315n;
        tx.outputs[1]!.valueSats = 999n;
      },
    ],
  ])('rejects %s', async (code, mutate) => {
    const transaction = deepCopyTransaction(circleTransaction());
    mutate(transaction);
    const result = await evaluate(transaction);
    expect(result).toMatchObject({ classification: 'invalid', code });
  });

  it('rejects a known noncurrent shard', async () => {
    const lookup = new MemoryLookup();
    lookup.addActiveShard(TXID_A, 0, 'a1'.repeat(32), SCRIPT_A, 30_000n);
    lookup.shards.get(`${TXID_A}:0`)!.status = 'spent';
    expect(await evaluate(circleTransaction(), lookup)).toMatchObject({
      classification: 'invalid',
      code: 'NON_CURRENT_SHARD',
    });
  });

  it('rejects shard and lineage state disagreement', async () => {
    const lookup = new MemoryLookup();
    const lineageId = 'a1'.repeat(32);
    lookup.addActiveShard(TXID_A, 0, lineageId, SCRIPT_A, 30_000n);
    lookup.lineages.get(lineageId)!.currentVout = 9;
    expect(await evaluate(circleTransaction(), lookup)).toMatchObject({
      classification: 'invalid',
      code: 'LINEAGE_STATE_MISMATCH',
    });
  });

  it('closes an active lineage on an ordinary spend without interpreting a transfer', async () => {
    const lookup = new MemoryLookup();
    const lineageId = 'a1'.repeat(32);
    lookup.addActiveShard(TXID_A, 0, lineageId, SCRIPT_A, 30_000n);
    const transaction = deepCopyTransaction(circleTransaction());
    transaction.txid = '99'.repeat(32);
    transaction.outputs = [{ valueSats: 29_000n, scriptPubKeyHex: SCRIPT_B }];
    transaction.inputs = [transaction.inputs[0]!];
    const result = await evaluate(transaction, lookup);
    expect(result).toMatchObject({
      classification: 'none',
      closures: [{ lineageId, reason: 'ordinary_spend' }],
    });
  });

  it('orders multiple closures by ordinal lineage id regardless of host collation', async () => {
    const lookup = new MemoryLookup();
    const low = '11'.repeat(32);
    const high = 'ff'.repeat(32);
    lookup.addActiveShard(TXID_A, 0, high, SCRIPT_A, 30_000n);
    lookup.addActiveShard(TXID_B, 1, low, SCRIPT_B, 40_000n);
    const transaction = deepCopyTransaction(circleTransaction());
    transaction.txid = '98'.repeat(32);
    transaction.outputs = [{ valueSats: 69_000n, scriptPubKeyHex: SCRIPT_A }];
    const originalLocaleCompare = String.prototype.localeCompare;
    try {
      String.prototype.localeCompare = () => -1;
      const result = await evaluate(transaction, lookup);
      if (result.classification !== 'none') throw new Error('Expected an ordinary spend');
      expect(result.closures.map(({ lineageId }) => lineageId)).toEqual([low, high]);
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
    }
  });

  it('closes active lineages when a marker is invalid', async () => {
    const lookup = new MemoryLookup();
    const lineageId = 'a1'.repeat(32);
    lookup.addActiveShard(TXID_A, 0, lineageId, SCRIPT_A, 30_000n);
    const transaction = circleTransaction();
    transaction.version = 1;
    const result = await evaluate(transaction, lookup);
    expect(result).toMatchObject({
      classification: 'invalid',
      closures: [{ lineageId, reason: 'invalid_protocol_spend' }],
    });
  });

  it('observes future versions and closes consumed v1 lineages', async () => {
    const lookup = new MemoryLookup();
    const lineageId = 'a1'.repeat(32);
    lookup.addActiveShard(TXID_A, 0, lineageId, SCRIPT_A, 30_000n);
    const transaction = circleTransaction();
    const marker = Buffer.from(transaction.outputs[0]!.scriptPubKeyHex, 'hex');
    marker[6] = 2;
    transaction.outputs[0]!.scriptPubKeyHex = marker.toString('hex');
    expect(await evaluate(transaction, lookup)).toMatchObject({
      classification: 'observed',
      version: 2,
      closures: [{ lineageId, reason: 'unknown_version_spend' }],
    });
  });

  it('rejects a marker from another network', async () => {
    const transaction = circleTransaction();
    transaction.outputs[0]!.scriptPubKeyHex = encodeWitnessScript(
      WitnessNetwork.SIGNET,
      2,
      CONTEXT_HASH,
    );
    expect(await evaluate(transaction)).toMatchObject({
      classification: 'invalid',
      code: 'NETWORK_MISMATCH',
    });
  });

  it('uses a stable tagged wire-outpoint lineage id', () => {
    expect(deriveLineageId({ txid: TXID_A, vout: 0 })).toBe(
      '4bc0f5c804bffee98f9d5239c11d6b9ed7473af856c6f9709763cb44276f5617',
    );
    expect(() => deriveLineageId({ txid: 'nope', vout: 0 })).toThrow();
    expect(() => deriveLineageId({ txid: TXID_A, vout: -1 })).toThrow();
  });

  it('never interprets REFUEL opcode 2 in v1', async () => {
    const transaction = circleTransaction();
    const marker = Buffer.from(transaction.outputs[0]!.scriptPubKeyHex, 'hex');
    marker[8] = 2;
    transaction.outputs[0]!.scriptPubKeyHex = marker.toString('hex');
    expect(await evaluate(transaction)).toMatchObject({
      classification: 'invalid',
      code: 'UNKNOWN_OPCODE',
    });
  });

  it('keeps the fixture txid independent from semantic lineage identifiers', () => {
    expect(CIRCLE_TXID).not.toBe(deriveLineageId({ txid: TXID_B, vout: 1 }));
  });
});
