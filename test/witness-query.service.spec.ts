import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { WitnessQueryService } from '../src/api/witness-query.service';
import { BitcoinRpcClient } from '../src/bitcoin/bitcoin-rpc.client';
import { AppConfiguration } from '../src/config/configuration';
import { LineageClosureEntity } from '../src/database/entities';
import { IndexerStore } from '../src/indexer/indexer.store';
import { SyncStatusService, type SyncStatusSnapshot } from '../src/indexer/sync-status.service';
import { WitnessStateEngine } from '../src/protocol';

const TIP_HEIGHT = 840_001;
const INDEXED_HASH = '11'.repeat(32);

function queryService(input: {
  nodeHash?: string;
  runtime?: Partial<SyncStatusSnapshot>;
  dataSource?: DataSource;
}): WitnessQueryService {
  const dataSource =
    input.dataSource ??
    ({
      query: jest.fn().mockResolvedValue([{}]),
    } as unknown as DataSource);
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
    mempoolSyncing: false,
    mempoolSequence: null,
    lastMempoolError: null,
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
      if (key === 'indexer') return { confirmations: 1, mempoolPollMs: 10_000 };
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

describe('WitnessQueryService graph', () => {
  it('returns an empty graph for an explicit unknown lineage', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const manager = { find: jest.fn() };
    const service = queryService({
      dataSource: { query, manager } as unknown as DataSource,
    });

    await expect(
      service.graph({ lineageId: '33'.repeat(32), depth: 1, limit: 25 }),
    ).resolves.toEqual({ nodes: [], edges: [], truncated: false });
    expect(manager.find).not.toHaveBeenCalled();
  });

  it('seeds lineage graphs only from canonical circles with deterministic bounds', async () => {
    const circleTxid = '44'.repeat(32);
    const query = jest.fn().mockResolvedValue([{ circleTxid }]);
    const manager = {
      find: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ circleTxid, canonical: true }]),
    };
    const service = queryService({
      dataSource: { query, manager } as unknown as DataSource,
    });

    await expect(
      service.graph({ lineageId: '55'.repeat(32), depth: 1, limit: 25 }),
    ).resolves.toMatchObject({
      nodes: [{ circleTxid, canonical: true }],
      edges: [],
      truncated: false,
    });
    expect(String(query.mock.calls[0]?.[0])).toContain(
      'JOIN wc_circles c ON c.circle_txid = m.circle_txid',
    );
    expect(String(query.mock.calls[0]?.[0])).toContain('c.canonical = TRUE');
    expect(String(query.mock.calls[0]?.[0])).toContain(
      'ORDER BY c.block_height DESC, c.tx_position DESC, c.circle_txid DESC',
    );
    expect(query.mock.calls[0]?.[1]).toEqual(['55'.repeat(32), 26]);
    expect(manager.find.mock.calls[0]?.[1]).toMatchObject({
      take: 2_001,
      order: {
        blockHeight: 'ASC',
        fromCircleTxid: 'ASC',
        toCircleTxid: 'ASC',
        lineageId: 'ASC',
      },
    });
  });
});

describe('WitnessQueryService lineage history compatibility', () => {
  it('keeps an unparameterized history request complete', async () => {
    const circle = { txid: '44'.repeat(32), blockHeight: 1 };
    const shard = { txid: '55'.repeat(32), vout: 1 };
    const query = jest.fn().mockResolvedValue([circle]);
    const manager = {
      find: jest.fn(async (entity: unknown) => (entity === LineageClosureEntity ? [] : [shard])),
    };
    const service = queryService({
      dataSource: { query, manager } as unknown as DataSource,
    });

    await expect(service.lineageHistory('66'.repeat(32), {})).resolves.toEqual({
      circles: [circle],
      closures: [],
      shards: [shard],
    });
    expect(String(query.mock.calls[0]?.[0])).not.toContain('LIMIT');
  });
});

describe('WitnessQueryService transaction closures', () => {
  it.each([
    {
      label: 'canonical ordinary spend',
      canonical: true,
      reason: 'ordinary_spend',
      invalid: null,
    },
    {
      label: 'orphaned invalid-marker spend',
      canonical: false,
      reason: 'invalid_protocol_spend',
      invalid: { classification: 'invalid', error_code: 'PARTICIPANT_COUNT' },
    },
  ])('exposes closure records for a $label transaction', async ({ canonical, reason, invalid }) => {
    const txid = '66'.repeat(32);
    const closure = {
      spendingTxid: txid,
      lineageId: '77'.repeat(32),
      spendingVin: 1,
      shardTxid: '88'.repeat(32),
      shardVout: 2,
      reason,
      canonical,
    };
    const query = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('wc_invalid_events')) return Promise.resolve(invalid ? [invalid] : []);
      return Promise.resolve([]);
    });
    const manager = {
      findOneBy: jest
        .fn()
        .mockResolvedValueOnce({ txid, canonical })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
      find: jest.fn().mockResolvedValue([closure]),
    };
    const service = queryService({
      dataSource: { query, manager } as unknown as DataSource,
    });

    await expect(service.transaction(txid)).resolves.toMatchObject({
      transaction: { txid, canonical },
      invalid,
      closures: [closure],
    });
    expect(manager.find).toHaveBeenCalledWith(LineageClosureEntity, {
      where: { spendingTxid: txid },
      order: { spendingVin: 'ASC', lineageId: 'ASC' },
    });
  });
});

describe('WitnessQueryService address activity', () => {
  it('paginates canonical Circle and spent-shard closure activity in one stable order', async () => {
    const address = 'bcrt1pactivity000000000000000000000000000000000000';
    const newestTxid = '99'.repeat(32);
    const boundaryTxid = 'aa'.repeat(32);
    const lineageA = 'bb'.repeat(32);
    const lineageB = 'cc'.repeat(32);
    const firstPageRows = [
      {
        txid: newestTxid,
        blockHeight: 840_001,
        txPosition: 3,
        lineageId: lineageA,
        kind: 'closure',
        reason: 'ordinary_spend',
        activityKey: `x:${lineageA}`,
      },
      {
        txid: boundaryTxid,
        blockHeight: 840_000,
        txPosition: 12,
        lineageId: lineageB,
        kind: 'circle',
        activityKey: `c:${lineageB}`,
      },
      {
        txid: '98'.repeat(32),
        blockHeight: 839_999,
        txPosition: 1,
        lineageId: lineageA,
        kind: 'circle',
        activityKey: `c:${lineageA}`,
      },
    ];
    const query = jest.fn().mockResolvedValueOnce(firstPageRows).mockResolvedValueOnce([]);
    const service = queryService({
      dataSource: { query, manager: {} } as unknown as DataSource,
    });

    const first = await service.addressActivity(address, { limit: 2 });
    expect(first).toMatchObject({
      address,
      items: [
        { txid: newestTxid, kind: 'closure', reason: 'ordinary_spend' },
        { txid: boundaryTxid, kind: 'circle' },
      ],
      limit: 2,
      truncated: true,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    await service.addressActivity(address, {
      limit: 2,
      cursor: String(first.nextCursor),
    });

    const firstSql = String(query.mock.calls[0]?.[0]);
    expect(firstSql).toContain('UNION ALL');
    expect(firstSql).toContain('JOIN wc_shards shard');
    expect(firstSql).toContain('shard.address');
    expect(firstSql).toContain('JOIN wc_transactions tx');
    expect(firstSql).toContain('closure.canonical = TRUE');
    expect(firstSql).toContain('tx.canonical = TRUE');
    expect(firstSql).toContain('tx.position AS txPosition');
    expect(firstSql).toContain('WHERE activity.address = ?');
    expect(firstSql).toContain(
      'ORDER BY activity.blockHeight DESC, activity.txPosition DESC, activity.txid DESC',
    );
    expect(query.mock.calls[0]?.[1]).toEqual([address, 3]);

    const secondSql = String(query.mock.calls[1]?.[0]);
    expect(secondSql).toContain(
      '(activity.blockHeight, activity.txPosition, activity.txid, activity.activityKey) < (?, ?, ?, ?)',
    );
    expect(query.mock.calls[1]?.[1]).toEqual([
      address,
      840_000,
      12,
      boundaryTxid,
      `c:${lineageB}`,
      3,
    ]);
  });
});
