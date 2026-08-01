import {
  BitcoinTransaction,
  LineageRecord,
  ShardRecord,
  StateLookup,
  WitnessNetwork,
  encodeWitnessScript,
  outpointKey,
  scriptHash,
} from '../src/protocol';

export const TXID_A = '11'.repeat(32);
export const TXID_B = '22'.repeat(32);
export const TXID_C = '33'.repeat(32);
export const CIRCLE_TXID = '44'.repeat(32);
export const SCRIPT_A = `5120${'aa'.repeat(32)}`;
export const SCRIPT_B = `5120${'bb'.repeat(32)}`;
export const CONTEXT_HASH = 'cc'.repeat(32);
export const DEFAULT_SIGNATURE = '01'.repeat(64);

export function circleTransaction(): BitcoinTransaction {
  return {
    txid: CIRCLE_TXID,
    wtxid: '55'.repeat(32),
    version: 2,
    locktime: 0,
    vsize: 263,
    inputs: [
      {
        txid: TXID_A,
        vout: 0,
        sequence: 0xffff_fffd,
        witness: [DEFAULT_SIGNATURE],
        prevout: {
          valueSats: 30_000n,
          scriptPubKeyHex: SCRIPT_A,
          address: 'bcrt1ptestparticipantaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          blockHeight: 1,
          confirmed: true,
        },
      },
      {
        txid: TXID_B,
        vout: 1,
        sequence: 0xffff_fffd,
        witness: [`${DEFAULT_SIGNATURE}01`],
        prevout: {
          valueSats: 40_000n,
          scriptPubKeyHex: SCRIPT_B,
          address: 'bcrt1ptestparticipantbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          blockHeight: 1,
          confirmed: true,
        },
      },
    ],
    outputs: [
      {
        valueSats: 0n,
        scriptPubKeyHex: encodeWitnessScript(WitnessNetwork.REGTEST, 2, CONTEXT_HASH),
      },
      { valueSats: 28_684n, scriptPubKeyHex: SCRIPT_A },
      { valueSats: 38_685n, scriptPubKeyHex: SCRIPT_B },
    ],
  };
}

export function deepCopyTransaction(transaction: BitcoinTransaction): BitcoinTransaction {
  return {
    ...transaction,
    inputs: transaction.inputs.map((input) => ({
      ...input,
      witness: [...input.witness],
      ...(input.prevout ? { prevout: { ...input.prevout } } : {}),
    })),
    outputs: transaction.outputs.map((output) => ({ ...output })),
  };
}

export class MemoryLookup implements StateLookup {
  readonly shards = new Map<string, ShardRecord>();
  readonly lineages = new Map<string, LineageRecord>();

  shardByOutpoint(outpoint: { txid: string; vout: number }): Promise<ShardRecord | null> {
    return Promise.resolve(this.shards.get(outpointKey(outpoint)) ?? null);
  }

  lineageById(lineageId: string): Promise<LineageRecord | null> {
    return Promise.resolve(this.lineages.get(lineageId) ?? null);
  }

  addActiveShard(
    txid: string,
    vout: number,
    lineageId: string,
    scriptPubKeyHex: string,
    valueSats: bigint,
    createdCircleTxid = TXID_C,
  ): void {
    this.shards.set(outpointKey({ txid, vout }), {
      txid,
      vout,
      lineageId,
      valueSats,
      scriptPubKeyHex,
      scriptHash: scriptHash(scriptPubKeyHex),
      address: null,
      status: 'active',
      createdCircleTxid,
      previousTxid: null,
      previousVout: null,
    });
    this.lineages.set(lineageId, {
      id: lineageId,
      genesisTxid: txid,
      genesisVout: vout,
      currentTxid: txid,
      currentVout: vout,
      status: 'active',
      circleCount: 1,
      lastCircleTxid: createdCircleTxid,
    });
  }
}
