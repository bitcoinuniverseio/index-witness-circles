import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { BitcoinRpcClient, type RawMempoolEntry } from '../src/bitcoin/bitcoin-rpc.client';
import { AppConfiguration } from '../src/config/configuration';
import { IndexerLeaseHandle, IndexerLeaseService } from '../src/indexer/indexer-lease.service';
import { IndexerStore } from '../src/indexer/indexer.store';
import { MempoolService } from '../src/indexer/mempool.service';
import { WitnessStateEngine } from '../src/protocol';

const TIP_HASH = '11'.repeat(32);
const PARENT = 'ff'.repeat(32);
const CHILD = '00'.repeat(32);
const ENTRY: RawMempoolEntry = {
  vsize: 100,
  weight: 400,
  time: 1,
  height: 1,
  descendantcount: 1,
  descendantsize: 100,
  ancestorcount: 1,
  ancestorsize: 100,
  fees: { base: 0.000001, modified: 0.000001, ancestor: 0.000001, descendant: 0.000001 },
  depends: [],
  spentby: [],
  'bip125-replaceable': true,
};

function createMempoolService(local: unknown[] = []): {
  service: MempoolService;
  dataSource: DataSource;
} {
  const rawQuery = jest.fn().mockResolvedValue([]);
  const conflictBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const dataSource = {
    manager: {
      findBy: jest.fn().mockResolvedValue(local),
      createQueryBuilder: jest.fn().mockReturnValue(conflictBuilder),
      query: rawQuery,
    },
    query: rawQuery,
    createQueryRunner: jest.fn(function (this: { manager: unknown }) {
      return {
        manager: this.manager,
        connect: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
      };
    }),
  } as unknown as DataSource;
  const lease = {
    fencedTransaction: jest.fn(
      async (
        _handle: IndexerLeaseHandle,
        _isolation: string,
        callback: (manager: { query: jest.Mock }) => Promise<unknown>,
      ) => callback({ query: jest.fn().mockResolvedValue([]) }),
    ),
  } as unknown as IndexerLeaseService;
  const store = {
    getCheckpoint: jest.fn().mockResolvedValue({ tipHeight: 10, tipHash: TIP_HASH }),
  } as unknown as IndexerStore;
  const config = {
    get: jest.fn((key: keyof AppConfiguration) =>
      key === 'indexer' ? { mempoolRetentionDays: 7 } : undefined,
    ),
  } as unknown as ConfigService<AppConfiguration, true>;
  return {
    service: new MempoolService(
      dataSource,
      {} as WitnessStateEngine,
      store,
      { emit: jest.fn() } as unknown as EventEmitter2,
      lease,
      config,
    ),
    dataSource,
  };
}

describe('mempool reconciliation completeness', () => {
  it('evaluates parents before children even when txid order is opposite', async () => {
    const { service } = createMempoolService();
    const seen: string[] = [];
    jest.spyOn(service, 'ingest').mockImplementation(async (transaction) => {
      seen.push(transaction.txid);
      return { txid: transaction.txid, protocolStatus: 'none', protocolCode: null, conflicts: [] };
    });
    const rpc = {
      getRawTransaction: jest.fn(async (txid: string) => ({ txid })),
      hydratePrevouts: jest.fn(async (transaction: { txid: string }) => transaction),
    } as unknown as BitcoinRpcClient;
    const snapshot = {
      [CHILD]: { ...ENTRY, depends: [PARENT] },
      [PARENT]: ENTRY,
    };

    await service.reconcile(rpc, { fencingToken: '1' } as IndexerLeaseHandle, snapshot);
    expect(seen).toEqual([PARENT, CHILD]);
  });

  it('does not report a successful reconciliation after any ingest failure', async () => {
    const { service } = createMempoolService();
    const rpc = {
      getRawTransaction: jest.fn().mockRejectedValue(new Error('missing transaction')),
    } as unknown as BitcoinRpcClient;
    await expect(
      service.reconcile(rpc, { fencingToken: '1' } as IndexerLeaseHandle, { [PARENT]: ENTRY }),
    ).rejects.toThrow(/could not evaluate 1 transaction/);
  });

  it('re-evaluates known active transactions after the canonical tip changes', async () => {
    const { service } = createMempoolService([
      { txid: PARENT, status: 'active', evaluatedTipHeight: 9, evaluatedTipHash: '99'.repeat(32) },
    ]);
    const ingest = jest.spyOn(service, 'ingest').mockResolvedValue({
      txid: PARENT,
      protocolStatus: 'none',
      protocolCode: null,
      conflicts: [],
    });
    const rpc = {
      getRawTransaction: jest.fn(async (txid: string) => ({ txid })),
      hydratePrevouts: jest.fn(async (transaction: { txid: string }) => transaction),
    } as unknown as BitcoinRpcClient;

    await service.reconcile(rpc, { fencingToken: '1' } as IndexerLeaseHandle, {
      [PARENT]: ENTRY,
    });
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('infers a removal-before-add replacement from persisted shared inputs', async () => {
    const { service, dataSource } = createMempoolService();
    (dataSource.manager.query as jest.Mock).mockResolvedValue([{ txid: CHILD }]);
    const internal = service as unknown as {
      findActiveCompetitor(txid: string, nodeTxids: Set<string>): Promise<string | null>;
    };
    await expect(internal.findActiveCompetitor(PARENT, new Set([CHILD]))).resolves.toBe(CHILD);
  });
});
