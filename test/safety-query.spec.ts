import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { WitnessQueryService } from '../src/api/witness-query.service';
import { BitcoinRpcClient, BitcoinRpcError } from '../src/bitcoin/bitcoin-rpc.client';
import { AppConfiguration } from '../src/config/configuration';
import { IndexerStore } from '../src/indexer/indexer.store';
import { SyncStatusService } from '../src/indexer/sync-status.service';
import { WitnessStateEngine } from '../src/protocol';

const TIP_HEIGHT = 840_001;
const TIP_HASH = '11'.repeat(32);
const TARGET_TXID = '22'.repeat(32);

function createService(input: {
  coreTxids?: string[];
  secondNodeHash?: string;
  activeShards?: Array<Record<string, unknown>>;
  pendingOutputs?: Array<Record<string, unknown>>;
  pendingSpends?: Array<Record<string, unknown>>;
  nodeSpenders?: Record<string, string>;
  projectedTxids?: string[];
  runtime?: Record<string, unknown>;
}): WitnessQueryService {
  const coreTxids = input.coreTxids ?? [];
  const projectedTxids = input.projectedTxids ?? [
    ...coreTxids,
    ...Object.values(input.nodeSpenders ?? {}),
  ];
  const query = jest.fn((sql: string) => {
    if (sql.includes('evaluated_tip_hash')) {
      return Promise.resolve(projectedTxids.map((txid) => ({ txid, evaluatedTipHash: TIP_HASH })));
    }
    if (sql.includes('FROM wc_shards')) return Promise.resolve(input.activeShards ?? []);
    if (
      sql.includes('protocol_status AS protocolStatus') &&
      sql.includes('FROM wc_mempool_transactions')
    ) {
      return Promise.resolve(input.pendingOutputs ?? []);
    }
    if (sql.includes('FROM wc_mempool_inputs')) {
      return Promise.resolve(input.pendingSpends ?? []);
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const manager = {
    findOneBy: jest.fn().mockResolvedValue({
      id: 'canonical',
      tipHeight: TIP_HEIGHT,
      tipHash: TIP_HASH,
      stateRoot: '33'.repeat(32),
    }),
    query,
  };
  const dataSource = {
    transaction: jest.fn(
      async (_isolation: string, callback: (value: typeof manager) => Promise<unknown>) =>
        callback(manager),
    ),
  } as unknown as DataSource;
  const rpc = {
    getBlockchainInfo: jest
      .fn()
      .mockResolvedValueOnce({
        chain: 'regtest',
        blocks: TIP_HEIGHT,
        bestblockhash: TIP_HASH,
        initialblockdownload: false,
      })
      .mockResolvedValueOnce({
        chain: 'regtest',
        blocks: TIP_HEIGHT,
        bestblockhash: input.secondNodeHash ?? TIP_HASH,
        initialblockdownload: false,
      }),
    getMempoolEntry: jest.fn(async (txid: string) => {
      if (coreTxids.includes(txid)) return {};
      throw new BitcoinRpcError('getmempoolentry', -5, 'Transaction not in mempool');
    }),
    getTxSpendingPrevout: jest.fn(async (outpoints: Array<{ txid: string; vout: number }>) =>
      outpoints.map(({ txid, vout }) => {
        const spendingtxid = input.nodeSpenders?.[`${txid}:${vout}`];
        return spendingtxid ? { txid, vout, spendingtxid } : { txid, vout };
      }),
    ),
  } as unknown as BitcoinRpcClient;
  const store = { startHeight: 0, network: 3 } as unknown as IndexerStore;
  const syncStatus = {
    snapshot: jest.fn().mockReturnValue({
      initialized: true,
      syncing: false,
      ready: true,
      leader: true,
      leaseFencingToken: '1',
      nodeHeight: TIP_HEIGHT,
      indexedHeight: TIP_HEIGHT,
      lastBlockAt: null,
      lastMempoolAt: new Date().toISOString(),
      mempoolSyncing: false,
      mempoolSequence: 7,
      lastMempoolError: null,
      lastVerificationAt: new Date().toISOString(),
      lastError: null,
      ...input.runtime,
    }),
  } as unknown as SyncStatusService;
  const config = {
    get: jest.fn((key: keyof AppConfiguration) => {
      if (key === 'network') return 'regtest';
      if (key === 'indexer') {
        return { confirmations: 1, mempoolPollMs: 10_000 };
      }
      return undefined;
    }),
  } as unknown as ConfigService<AppConfiguration, true>;
  return new WitnessQueryService(
    dataSource,
    rpc,
    store,
    {} as WitnessStateEngine,
    syncStatus,
    config,
  );
}

describe('exact outpoint safety snapshots', () => {
  it('returns an unclassified result only from a complete stable snapshot', async () => {
    await expect(
      createService({}).safetyOutpoints([{ txid: TARGET_TXID, vout: 0 }]),
    ).resolves.toMatchObject({
      complete: true,
      snapshot: {
        indexedHeight: TIP_HEIGHT,
        indexedHash: TIP_HASH,
        nodeHash: TIP_HASH,
        coreMempoolSequence: 7,
      },
      items: [
        {
          txid: TARGET_TXID,
          vout: 0,
          classification: 'unclassified',
          protected: false,
        },
      ],
    });
  });

  it('classifies confirmed shards and valid pending successors as protected', async () => {
    await expect(
      createService({
        activeShards: [
          { txid: TARGET_TXID, vout: 2, lineageId: '44'.repeat(32), circleTxid: '55'.repeat(32) },
        ],
      }).safetyOutpoints([{ txid: TARGET_TXID, vout: 2 }]),
    ).resolves.toMatchObject({
      items: [{ classification: 'active-shard', protected: true, lineageId: '44'.repeat(32) }],
    });

    await expect(
      createService({
        coreTxids: [TARGET_TXID],
        pendingOutputs: [
          {
            txid: TARGET_TXID,
            protocolStatus: 'valid',
            projectionJson: {
              participantCount: 2,
              lineages: [
                { lineageId: '66'.repeat(32), fresh: true },
                { lineageId: '77'.repeat(32), fresh: true },
              ],
            },
          },
        ],
      }).safetyOutpoints([{ txid: TARGET_TXID, vout: 1 }]),
    ).resolves.toMatchObject({
      items: [{ classification: 'pending-successor', protected: true, lineageId: '66'.repeat(32) }],
    });
  });

  it('gives a pending spend precedence over an otherwise active shard', async () => {
    await expect(
      createService({
        coreTxids: ['88'.repeat(32)],
        nodeSpenders: { [`${TARGET_TXID}:2`]: '88'.repeat(32) },
        activeShards: [
          { txid: TARGET_TXID, vout: 2, lineageId: '44'.repeat(32), circleTxid: '55'.repeat(32) },
        ],
        pendingSpends: [
          { txid: TARGET_TXID, vout: 2, spendingTxid: '88'.repeat(32), protocolStatus: 'valid' },
        ],
      }).safetyOutpoints([{ txid: TARGET_TXID, vout: 2 }]),
    ).resolves.toMatchObject({
      items: [
        {
          classification: 'pending-spend',
          protected: true,
          lineageId: '44'.repeat(32),
          spendingTxids: ['88'.repeat(32)],
        },
      ],
    });
  });

  it('preserves successor provenance when another mempool transaction spends it', async () => {
    const spendingTxid = '99'.repeat(32);
    await expect(
      createService({
        coreTxids: [TARGET_TXID, spendingTxid],
        nodeSpenders: { [`${TARGET_TXID}:1`]: spendingTxid },
        pendingOutputs: [
          {
            txid: TARGET_TXID,
            protocolStatus: 'valid',
            projectionJson: {
              participantCount: 2,
              lineages: [
                { lineageId: '66'.repeat(32), fresh: true },
                { lineageId: '77'.repeat(32), fresh: true },
              ],
            },
          },
        ],
        pendingSpends: [
          {
            txid: TARGET_TXID,
            vout: 1,
            spendingTxid,
            protocolStatus: 'none',
          },
        ],
      }).safetyOutpoints([{ txid: TARGET_TXID, vout: 1 }]),
    ).resolves.toMatchObject({
      items: [
        {
          classification: 'pending-spend',
          lineageId: '66'.repeat(32),
          circleTxid: TARGET_TXID,
          spendingTxids: [spendingTxid],
        },
      ],
    });
  });

  it('answers while a mempool pass runs and the mempool has moved on', async () => {
    await expect(
      createService({
        coreTxids: ['aa'.repeat(32)],
        runtime: { mempoolSyncing: true, mempoolSequence: 3 },
      }).safetyOutpoints([{ txid: TARGET_TXID, vout: 0 }]),
    ).resolves.toMatchObject({
      items: [{ classification: 'unclassified', protected: false }],
    });
  });

  it('protects an outpoint Core sees spent in its mempool', async () => {
    const spendingTxid = 'bb'.repeat(32);
    await expect(
      createService({
        nodeSpenders: { [`${TARGET_TXID}:0`]: spendingTxid },
      }).safetyOutpoints([{ txid: TARGET_TXID, vout: 0 }]),
    ).resolves.toMatchObject({
      items: [{ classification: 'pending-spend', protected: true, spendingTxids: [spendingTxid] }],
    });
  });

  it('fails closed when a relevant mempool transaction is not projected yet', async () => {
    await expect(
      createService({
        nodeSpenders: { [`${TARGET_TXID}:0`]: 'cc'.repeat(32) },
        projectedTxids: [],
      }).safetyOutpoints([{ txid: TARGET_TXID, vout: 0 }]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      createService({ coreTxids: [TARGET_TXID], projectedTxids: [] }).safetyOutpoints([
        { txid: TARGET_TXID, vout: 0 },
      ]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('marks an outpoint whose creating transaction is unconfirmed as protected', async () => {
    await expect(
      createService({ coreTxids: [TARGET_TXID] }).safetyOutpoints([{ txid: TARGET_TXID, vout: 0 }]),
    ).resolves.toMatchObject({ items: [{ classification: 'unconfirmed', protected: true }] });
  });

  it('fails closed across a same-height tip replacement', async () => {
    await expect(
      createService({ secondNodeHash: '99'.repeat(32) }).safetyOutpoints([
        { txid: TARGET_TXID, vout: 0 },
      ]),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
