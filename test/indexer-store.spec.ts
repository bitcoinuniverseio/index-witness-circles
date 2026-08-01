import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { AppConfiguration } from '../src/config/configuration';
import { IndexerLeaseHandle, IndexerLeaseService } from '../src/indexer/indexer-lease.service';
import { IndexerStore } from '../src/indexer/indexer.store';
import { EMPTY_STATE_ROOT } from '../src/indexer/state-root';
import { WitnessStateEngine } from '../src/protocol';

describe('IndexerStore block roots', () => {
  it('reuses the checkpoint root and skips global scans for an unrelated block', async () => {
    const checkpoint = {
      id: 'canonical',
      network: 3,
      startHeight: 0,
      tipHeight: -1,
      tipHash: null,
      boundaryParentHash: null,
      stateRoot: EMPTY_STATE_ROOT,
      indexerVersion: '0.2.0',
      parserVersion: 'witc-v1.0.0',
      status: 'ready',
      lastError: null,
    };
    const manager = {
      findOne: jest.fn().mockResolvedValue(checkpoint),
      upsert: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
      query: jest.fn(),
      update: jest.fn(),
    } as unknown as EntityManager;
    const lease = {
      fencedTransaction: jest.fn(
        (
          _handle: IndexerLeaseHandle,
          _isolation: string,
          work: (transactionManager: EntityManager) => Promise<unknown>,
        ) => work(manager),
      ),
    } as unknown as IndexerLeaseService;
    const config = {
      get: jest.fn((key: string) => (key === 'network' ? 'regtest' : { startHeight: 0 })),
    } as unknown as ConfigService<AppConfiguration, true>;
    const store = new IndexerStore({} as DataSource, config, {} as WitnessStateEngine, lease);
    const handle: IndexerLeaseHandle = {
      leaseName: 'witness-canonical-ingester',
      ownerId: 'test',
      fencingToken: '1',
      expiresAtMs: Date.now() + 10_000,
    };

    const result = await store.processBlock(
      {
        hash: 'aa'.repeat(32),
        previousBlockHash: null,
        height: 0,
        time: 1,
        medianTime: 1,
        transactions: [],
      },
      handle,
    );

    expect(result.stateRoot).toBe(EMPTY_STATE_ROOT);
    expect(manager.query).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('confirms mempool rows in the same fenced transaction as the block checkpoint', async () => {
    const txid = '11'.repeat(32);
    const checkpoint = {
      id: 'canonical',
      network: 3,
      startHeight: 0,
      tipHeight: -1,
      tipHash: null,
      boundaryParentHash: null,
      stateRoot: EMPTY_STATE_ROOT,
      indexerVersion: '0.2.0',
      parserVersion: 'witc-v1.0.0',
      status: 'ready',
      lastError: null,
    };
    const manager = {
      findOne: jest.fn().mockResolvedValue(checkpoint),
      findBy: jest.fn().mockResolvedValue([{ txid }]),
      upsert: jest.fn().mockResolvedValue(undefined),
      save: jest.fn().mockImplementation((value: unknown) => Promise.resolve(value)),
      query: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as EntityManager;
    const lease = {
      fencedTransaction: jest.fn(
        (
          _handle: IndexerLeaseHandle,
          _isolation: string,
          work: (transactionManager: EntityManager) => Promise<unknown>,
        ) => work(manager),
      ),
    } as unknown as IndexerLeaseService;
    const config = {
      get: jest.fn((key: string) => (key === 'network' ? 'regtest' : { startHeight: 0 })),
    } as unknown as ConfigService<AppConfiguration, true>;
    const engine = {
      evaluate: jest.fn().mockResolvedValue({ classification: 'none', closures: [] }),
    } as unknown as WitnessStateEngine;
    const store = new IndexerStore({} as DataSource, config, engine, lease);
    const handle: IndexerLeaseHandle = {
      leaseName: 'witness-canonical-ingester',
      ownerId: 'test',
      fencingToken: '1',
      expiresAtMs: Date.now() + 10_000,
    };

    await store.processBlock(
      {
        hash: 'aa'.repeat(32),
        previousBlockHash: null,
        height: 0,
        time: 1,
        medianTime: 1,
        transactions: [{ txid, version: 2, locktime: 0, inputs: [], outputs: [] }],
      },
      handle,
    );

    expect(lease.fencedTransaction).toHaveBeenCalledTimes(1);
    expect(manager.update).toHaveBeenCalledWith(
      expect.any(Function),
      { txid },
      { status: 'confirmed' },
    );
  });
});
