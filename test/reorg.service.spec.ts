import { EventEmitter2 } from '@nestjs/event-emitter';
import { EntityManager } from 'typeorm';
import { BitcoinRpcClient } from '../src/bitcoin/bitcoin-rpc.client';
import { IndexerLeaseHandle, IndexerLeaseService } from '../src/indexer/indexer-lease.service';
import { IndexerStore } from '../src/indexer/indexer.store';
import { ReorgService } from '../src/indexer/reorg.service';

describe('ReorgService', () => {
  it('restores an unavailable start boundary after Core regrows to it', async () => {
    const checkpoint = {
      tipHeight: 99,
      tipHash: null,
      boundaryParentHash: null,
    };
    const boundaryHash = 'ab'.repeat(32);
    const store = {
      startHeight: 100,
      getCheckpoint: jest.fn().mockResolvedValue(checkpoint),
      setBoundaryParentHash: jest.fn(),
    } as unknown as IndexerStore;
    const rpc = {
      getBlockCount: jest.fn().mockResolvedValue(100),
      getBlockHash: jest.fn().mockResolvedValue(boundaryHash),
    } as unknown as BitcoinRpcClient;
    const lease = {} as IndexerLeaseService;
    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    const service = new ReorgService(rpc, store, events, lease);
    const handle = {
      leaseName: 'witness-canonical-ingester',
      ownerId: 'test',
      fencingToken: '1',
      expiresAtMs: Date.now() + 10_000,
    } satisfies IndexerLeaseHandle;

    await expect(service.reconcileCanonicalChain(handle)).resolves.toEqual({ reorged: false });
    expect(rpc.getBlockHash).toHaveBeenCalledWith(99);
    expect(store.setBoundaryParentHash).toHaveBeenCalledWith(boundaryHash, handle);
  });

  it('rolls back a local tip above the current Core height without querying a missing height', async () => {
    const checkpoint = {
      tipHeight: 105,
      tipHash: 'aa'.repeat(32),
    };
    const store = {
      startHeight: 0,
      getCheckpoint: jest.fn().mockResolvedValue(checkpoint),
      getCanonicalBlockHash: jest.fn().mockResolvedValue('bb'.repeat(32)),
      rollbackToHeight: jest.fn().mockResolvedValue(2),
      setBoundaryParentHash: jest.fn(),
    } as unknown as IndexerStore;
    const rpc = {
      getBlockCount: jest.fn().mockResolvedValue(103),
      getBlockHash: jest.fn().mockResolvedValue('bb'.repeat(32)),
      getBestBlockHash: jest.fn().mockResolvedValue('cc'.repeat(32)),
    } as unknown as BitcoinRpcClient;
    const manager = {
      create: jest.fn((_entity: unknown, value: unknown) => value),
      save: jest.fn((_entity: unknown, value?: unknown) => Promise.resolve(value ?? _entity)),
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
    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    const service = new ReorgService(rpc, store, events, lease);
    const handle = {
      leaseName: 'witness-canonical-ingester',
      ownerId: 'test',
      fencingToken: '1',
      expiresAtMs: Date.now() + 10_000,
    } satisfies IndexerLeaseHandle;

    await expect(service.reconcileCanonicalChain(handle)).resolves.toMatchObject({
      reorged: true,
      oldTipHash: checkpoint.tipHash,
      newTipHash: 'cc'.repeat(32),
      forkHeight: 103,
      depth: 2,
    });
    expect(store.getCanonicalBlockHash).toHaveBeenCalledWith(103);
    expect(store.rollbackToHeight).toHaveBeenCalledWith(103, handle);
    expect(
      (rpc.getBlockHash as jest.Mock).mock.calls.every(([height]) => Number(height) <= 103),
    ).toBe(true);
    expect(events.emit).toHaveBeenCalledWith(
      'witness.reorg',
      expect.objectContaining({ forkHeight: 103, depth: 2 }),
    );
  });
});
