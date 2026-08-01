import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import { AppConfiguration } from '../src/config/configuration';
import {
  MempoolInputEntity,
  MempoolTransactionEntity,
  TransactionEntity,
} from '../src/database/entities';
import { IndexerLeaseHandle, IndexerLeaseService } from '../src/indexer/indexer-lease.service';
import { IndexerStore } from '../src/indexer/indexer.store';
import { MempoolService } from '../src/indexer/mempool.service';
import { BitcoinTransaction, WitnessStateEngine } from '../src/protocol';

describe('MempoolService ingest ordering', () => {
  it('never reactivates a transaction that confirmed before the fenced ingest starts', async () => {
    const txid = '11'.repeat(32);
    const transaction = {
      txid,
      version: 2,
      locktime: 0,
      inputs: [],
      outputs: [],
    } as BitcoinTransaction;
    const manager = {
      findOneBy: jest.fn(async (entity: unknown) =>
        entity === TransactionEntity ? { txid, canonical: true, confirmed: true } : null,
      ),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      upsert: jest.fn().mockResolvedValue(undefined),
    } as unknown as EntityManager;
    const lease = {
      fencedTransaction: jest.fn(
        async (
          _handle: IndexerLeaseHandle,
          _isolation: string,
          work: (transactionManager: EntityManager) => Promise<unknown>,
        ) => work(manager),
      ),
    } as unknown as IndexerLeaseService;
    const engine = { evaluate: jest.fn() } as unknown as WitnessStateEngine;
    const events = { emit: jest.fn() } as unknown as EventEmitter2;
    const config = {
      get: jest.fn(() => ({ mempoolRetentionDays: 7 })),
    } as unknown as ConfigService<AppConfiguration, true>;
    const service = new MempoolService(
      {} as DataSource,
      engine,
      { network: 3 } as IndexerStore,
      events,
      lease,
      config,
    );

    await expect(
      service.ingest(transaction, { fencingToken: '1' } as IndexerLeaseHandle),
    ).resolves.toEqual({
      txid,
      protocolStatus: 'none',
      protocolCode: null,
      conflicts: [],
      skippedConfirmed: true,
    });
    expect(engine.evaluate).not.toHaveBeenCalled();
    expect(manager.upsert).not.toHaveBeenCalled();
    expect(manager.update).toHaveBeenCalledWith(
      MempoolTransactionEntity,
      { txid },
      { status: 'confirmed' },
    );
    expect(manager.delete).toHaveBeenCalledWith(MempoolInputEntity, { txid });
    expect(events.emit).not.toHaveBeenCalled();
  });
});
