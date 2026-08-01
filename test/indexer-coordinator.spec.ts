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
