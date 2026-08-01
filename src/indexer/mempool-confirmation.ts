import { EntityManager, In, Not } from 'typeorm';
import { ConflictEntity, MempoolInputEntity, MempoolTransactionEntity } from '../database/entities';
import { BitcoinTransaction } from '../protocol';

export async function confirmMempoolTransactions(
  manager: EntityManager,
  transactions: BitcoinTransaction[],
): Promise<void> {
  if (transactions.length === 0) return;
  const known = await manager.findBy(MempoolTransactionEntity, {
    txid: In(transactions.map(({ txid }) => txid)),
  });
  const knownIds = new Set(known.map(({ txid }) => txid));
  for (const transaction of transactions) {
    if (knownIds.has(transaction.txid)) {
      await manager.update(
        MempoolTransactionEntity,
        { txid: transaction.txid },
        { status: 'confirmed' },
      );
    }
    for (const input of transaction.inputs) {
      if (!input.txid || input.vout === undefined) continue;
      const competing = await manager.findBy(MempoolInputEntity, {
        prevTxid: input.txid,
        prevVout: input.vout,
        txid: Not(transaction.txid),
      });
      if (competing.length > 0) {
        await manager.update(
          MempoolTransactionEntity,
          {
            txid: In(competing.map(({ txid }) => txid)),
            status: In(['active', 'removed']),
          },
          { status: 'conflicted' },
        );
      }
      await manager
        .createQueryBuilder()
        .update(ConflictEntity)
        .set({ status: 'resolved', winnerTxid: transaction.txid, resolvedAt: new Date() })
        .where('prev_txid = :txid AND prev_vout = :vout AND status = :status', {
          txid: input.txid,
          vout: input.vout,
          status: 'open',
        })
        .execute();
    }
  }
}
