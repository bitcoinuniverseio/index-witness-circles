import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { WitnessQueryService } from '../src/api/witness-query.service';
import { BitcoinRpcClient } from '../src/bitcoin/bitcoin-rpc.client';
import { AppConfiguration } from '../src/config/configuration';
import { IndexerStore } from '../src/indexer/indexer.store';
import { SyncStatusService, type SyncStatusSnapshot } from '../src/indexer/sync-status.service';
import { WitnessStateEngine } from '../src/protocol';

const TIP_HEIGHT = 840_001;
const INDEXED_HASH = '11'.repeat(32);

function queryService(input: {
  nodeHash?: string;
  runtime?: Partial<SyncStatusSnapshot>;
}): WitnessQueryService {
  const dataSource = {
    query: jest.fn().mockResolvedValue([{}]),
  } as unknown as DataSource;
  const rpc = {
    getBlockchainInfo: jest.fn().mockResolvedValue({
      blocks: TIP_HEIGHT,
      bestblockhash: input.nodeHash ?? INDEXED_HASH,
    }),
  } as unknown as BitcoinRpcClient;
  const store = {
    startHeight: 0,
    getCheckpoint: jest.fn().mockResolvedValue({
      tipHeight: TIP_HEIGHT,
      tipHash: INDEXED_HASH,
      stateRoot: '22'.repeat(32),
    }),
  } as unknown as IndexerStore;
  const runtime = {
    initialized: true,
    syncing: false,
    ready: true,
    leader: true,
    leaseFencingToken: '1',
    nodeHeight: TIP_HEIGHT,
    indexedHeight: TIP_HEIGHT,
    lastBlockAt: null,
    lastMempoolAt: null,
    lastVerificationAt: '2026-08-01T10:00:00.000Z',
    lastError: null,
    ...input.runtime,
  } satisfies SyncStatusSnapshot;
  const syncStatus = {
    snapshot: jest.fn().mockReturnValue(runtime),
  } as unknown as SyncStatusService;
  const config = {
    get: jest.fn((key: keyof AppConfiguration) => {
      if (key === 'network') return 'regtest';
      if (key === 'indexer') return { confirmations: 1 };
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

describe('WitnessQueryService status', () => {
  it('reports synced only when the checkpoint matches the active Bitcoin Core tip', async () => {
    await expect(queryService({}).status()).resolves.toMatchObject({
      indexedHeight: TIP_HEIGHT,
      indexedHash: INDEXED_HASH,
      nodeHeight: TIP_HEIGHT,
      nodeHash: INDEXED_HASH,
      synced: true,
    });

    await expect(queryService({ nodeHash: '33'.repeat(32) }).status()).resolves.toMatchObject({
      indexedHeight: TIP_HEIGHT,
      nodeHeight: TIP_HEIGHT,
      synced: false,
    });
  });

  it.each([
    ['not initialized', { initialized: false }],
    ['not ready', { ready: false }],
    ['still syncing', { syncing: true }],
    ['in error', { lastError: 'reorg reconciliation failed' }],
  ] as const)('fails closed while runtime is %s', async (_label, runtime) => {
    await expect(queryService({ runtime }).status()).resolves.toMatchObject({
      synced: false,
    });
  });
});
