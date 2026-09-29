import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BitcoinRpcClient } from '../src/bitcoin/bitcoin-rpc.client';
import { BitcoinZmqService } from '../src/bitcoin/bitcoin-zmq.service';
import { AppConfiguration } from '../src/config/configuration';
import { checkpointMatchesCoreTip, IndexerCoordinator } from '../src/indexer/indexer.coordinator';
import { IndexerLeaseHandle, IndexerLeaseService } from '../src/indexer/indexer-lease.service';
import { IndexerStore } from '../src/indexer/indexer.store';
import { MempoolService } from '../src/indexer/mempool.service';
import { ReorgService } from '../src/indexer/reorg.service';
import { SyncStatusService } from '../src/indexer/sync-status.service';

describe('IndexerCoordinator readiness and sequence handling', () => {
  it('does not report ready when Core is below the configured index boundary', () => {
    expect(
      checkpointMatchesCoreTip(
        { tipHeight: 99, tipHash: null, boundaryParentHash: null },
        { blocks: 50, bestblockhash: '11'.repeat(32) },
        100,
      ),
    ).toBe(false);
    expect(
      checkpointMatchesCoreTip(
        { tipHeight: 100, tipHash: '22'.repeat(32), boundaryParentHash: '33'.repeat(32) },
        { blocks: 100, bestblockhash: '22'.repeat(32) },
        100,
      ),
    ).toBe(true);
  });

  it('contains asynchronous sequence-removal failures for full reconciliation', async () => {
    const handle = { fencingToken: '1' } as IndexerLeaseHandle;
    const mempool = {
      markSequenceRemoval: jest.fn().mockRejectedValue(new Error('database unavailable')),
    } as unknown as MempoolService;
    const status = { patch: jest.fn() } as unknown as SyncStatusService;
    const config = {
      get: jest.fn((key: keyof AppConfiguration) =>
        key === 'network' ? 'regtest' : { enabled: true },
      ),
    } as unknown as ConfigService<AppConfiguration, true>;
    const lease = {
      currentLeadership: jest.fn().mockReturnValue(handle),
    } as unknown as IndexerLeaseService;
    const coordinator = new IndexerCoordinator(
      config,
      {} as BitcoinRpcClient,
      {} as BitcoinZmqService,
      {} as IndexerStore,
      mempool,
      {} as ReorgService,
      status,
      {} as EventEmitter2,
      lease,
    );

    coordinator.onSequence({
      txidOrBlockHash: '44'.repeat(32),
      label: 'R',
      sequence: 1n,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(status.patch).toHaveBeenCalledWith({ lastMempoolError: 'database unavailable' });
  });
});

describe('IndexerCoordinator mempool reconciliation on a busy mempool', () => {
  const TIP = '55'.repeat(32);
  const OLD = '66'.repeat(32);
  const NEW = '77'.repeat(32);

  function coordinatorFor(rpc: Partial<BitcoinRpcClient>, mempool: Partial<MempoolService>) {
    const handle = { fencingToken: '1' } as IndexerLeaseHandle;
    const status = { patch: jest.fn() } as unknown as SyncStatusService;
    const config = {
      get: jest.fn((key: keyof AppConfiguration) =>
        key === 'network' ? 'regtest' : { enabled: true },
      ),
    } as unknown as ConfigService<AppConfiguration, true>;
    const store = {
      getCheckpoint: jest.fn().mockResolvedValue({ tipHeight: 10, tipHash: TIP }),
    } as unknown as IndexerStore;
    const lease = {
      currentLeadership: jest.fn().mockReturnValue(handle),
    } as unknown as IndexerLeaseService;
    const coordinator = new IndexerCoordinator(
      config,
      rpc as BitcoinRpcClient,
      {} as BitcoinZmqService,
      store,
      mempool as MempoolService,
      {} as ReorgService,
      status,
      {} as EventEmitter2,
      lease,
    );
    return { coordinator, status };
  }

  it('completes against one sequence snapshot although the mempool keeps changing', async () => {
    const reconcile = jest.fn().mockResolvedValue({ added: 1, removed: 0, replaced: 0 });
    const getRawMempoolSequence = jest
      .fn()
      .mockResolvedValueOnce({ txids: [OLD], mempool_sequence: 40 })
      .mockResolvedValue({ txids: [OLD, NEW], mempool_sequence: 41 });
    const { coordinator, status } = coordinatorFor(
      {
        getBlockchainInfo: jest.fn().mockResolvedValue({ blocks: 10, bestblockhash: TIP }),
        getRawMempoolSequence,
        // NEW arrived between the two calls; it belongs to the next poll.
        getRawMempool: jest.fn().mockResolvedValue({ [OLD]: {}, [NEW]: {} }),
      } as unknown as Partial<BitcoinRpcClient>,
      { reconcile } as unknown as Partial<MempoolService>,
    );

    await coordinator.syncMempool();

    expect(Object.keys(reconcile.mock.calls[0][2] as object)).toEqual([OLD]);
    expect(status.patch).toHaveBeenCalledWith(
      expect.objectContaining({ mempoolSequence: 40, lastMempoolError: null }),
    );
  });

  it('still refuses a reconciliation that straddles a new block', async () => {
    const reconcile = jest.fn().mockResolvedValue({ added: 0, removed: 0, replaced: 0 });
    const { coordinator, status } = coordinatorFor(
      {
        getBlockchainInfo: jest
          .fn()
          .mockResolvedValueOnce({ blocks: 10, bestblockhash: TIP })
          .mockResolvedValue({ blocks: 11, bestblockhash: '88'.repeat(32) }),
        getRawMempoolSequence: jest.fn().mockResolvedValue({ txids: [], mempool_sequence: 1 }),
        getRawMempool: jest.fn().mockResolvedValue({}),
      } as unknown as Partial<BitcoinRpcClient>,
      { reconcile } as unknown as Partial<MempoolService>,
    );

    await coordinator.syncMempool();

    expect(status.patch).toHaveBeenCalledWith({
      lastMempoolError: 'Bitcoin Core chain changed during reconciliation',
    });
    expect(status.patch).not.toHaveBeenCalledWith(
      expect.objectContaining({ lastMempoolAt: expect.any(String) }),
    );
  });
});
