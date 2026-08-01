import { EntityManager } from 'typeorm';
import { MempoolTransactionEntity } from '../src/database/entities';
import { confirmMempoolTransactions } from '../src/indexer/mempool-confirmation';

describe('confirmMempoolTransactions', () => {
  it('confirms known block transactions and resolves their competing spends', async () => {
    const confirmedTxid = '11'.repeat(32);
    const competingTxid = '22'.repeat(32);
    const execute = jest.fn().mockResolvedValue(undefined);
    const queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute,
    };
    const manager = {
      findBy: jest
        .fn()
        .mockResolvedValueOnce([{ txid: confirmedTxid }])
        .mockResolvedValueOnce([{ txid: competingTxid }]),
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    } as unknown as EntityManager;

    await confirmMempoolTransactions(manager, [
      {
        txid: confirmedTxid,
        version: 2,
        locktime: 0,
        inputs: [{ txid: '33'.repeat(32), vout: 4, sequence: 0xffff_fffd, witness: [] }],
        outputs: [],
      },
    ]);

    expect(manager.update).toHaveBeenCalledWith(
      MempoolTransactionEntity,
      { txid: confirmedTxid },
      { status: 'confirmed' },
    );
    expect(manager.update).toHaveBeenCalledWith(MempoolTransactionEntity, expect.any(Object), {
      status: 'conflicted',
    });
    expect(queryBuilder.where).toHaveBeenCalledWith(
      'prev_txid = :txid AND prev_vout = :vout AND status = :status',
      { txid: '33'.repeat(32), vout: 4, status: 'open' },
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('conflicts locally active spenders even when the winning block transaction was never seen', async () => {
    const winnerTxid = '44'.repeat(32);
    const loserTxid = '55'.repeat(32);
    const manager = {
      findBy: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ txid: loserTxid }]),
      update: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn().mockReturnValue({
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      }),
    } as unknown as EntityManager;

    await confirmMempoolTransactions(manager, [
      {
        txid: winnerTxid,
        version: 2,
        locktime: 0,
        inputs: [{ txid: '66'.repeat(32), vout: 1, sequence: 0xffff_fffd, witness: [] }],
        outputs: [],
      },
    ]);

    expect(manager.update).not.toHaveBeenCalledWith(
      MempoolTransactionEntity,
      { txid: winnerTxid },
      { status: 'confirmed' },
    );
    expect(manager.update).toHaveBeenCalledWith(
      MempoolTransactionEntity,
      expect.objectContaining({ txid: expect.any(Object), status: expect.any(Object) }),
      { status: 'conflicted' },
    );
  });

  it('does not query TypeORM with an empty IN expression', async () => {
    const manager = { findBy: jest.fn() } as unknown as EntityManager;
    await confirmMempoolTransactions(manager, []);
    expect(manager.findBy).not.toHaveBeenCalled();
  });
});
