import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, Not } from 'typeorm';
import { BitcoinRpcClient, RawMempoolEntry } from '../bitcoin/bitcoin-rpc.client';
import { AppConfiguration } from '../config/configuration';
import {
  CheckpointEntity,
  ConflictEntity,
  InvalidEventEntity,
  MempoolInputEntity,
  MempoolTransactionEntity,
  ReplacementEntity,
} from '../database/entities';
import { BitcoinTransaction, PARSER_VERSION, WitnessStateEngine } from '../protocol';
import {
  IndexerLeaseHandle,
  IndexerLeaseLostError,
  IndexerLeaseService,
} from './indexer-lease.service';
import { DatabaseStateLookup, IndexerStore } from './indexer.store';

export interface MempoolIngestResult {
  txid: string;
  protocolStatus: string;
  protocolCode: string | null;
  conflicts: string[];
}

@Injectable()
export class MempoolService {
  private readonly logger = new Logger(MempoolService.name);
  private readonly retentionDays: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly engine: WitnessStateEngine,
    private readonly store: IndexerStore,
    private readonly events: EventEmitter2,
    private readonly lease: IndexerLeaseService,
    configService: ConfigService<AppConfiguration, true>,
  ) {
    this.retentionDays = configService.get('indexer', { infer: true }).mempoolRetentionDays;
  }

  async ingest(
    transaction: BitcoinTransaction,
    handle: IndexerLeaseHandle,
    entry?: RawMempoolEntry,
  ): Promise<MempoolIngestResult> {
    const result = await this.lease.fencedTransaction(handle, 'READ COMMITTED', async (manager) => {
      const checkpoint = await manager.findOneBy(CheckpointEntity, { id: 'canonical' });
      if (!checkpoint) throw new Error('Checkpoint is not initialized');
      const evaluation = await this.engine.evaluate(transaction, {
        network: this.store.network,
        blockHeight: checkpoint.tipHeight + 1,
        confirmed: false,
        lookup: new DatabaseStateLookup(manager),
      });
      const protocolStatus = evaluation.classification;
      const protocolCode = evaluation.classification === 'invalid' ? evaluation.code : null;
      await manager.upsert(
        MempoolTransactionEntity,
        {
          txid: transaction.txid,
          status: 'active',
          rawHex: transaction.hex ?? null,
          protocolStatus,
          protocolCode,
          projectionJson: this.projection(evaluation) as never,
          feeSats: entry ? BigInt(Math.round(entry.fees.base * 100_000_000)) : null,
          vsize: entry?.vsize ?? transaction.vsize ?? null,
        },
        ['txid'],
      );
      if (evaluation.classification === 'invalid' || evaluation.classification === 'observed') {
        const observed = evaluation.classification === 'observed';
        await manager.upsert(
          InvalidEventEntity,
          {
            txid: transaction.txid,
            classification: observed ? 'observed' : 'invalid',
            errorCode: observed ? 'UNKNOWN_VERSION' : evaluation.code,
            detail: observed
              ? `Observed unsupported WITC version ${evaluation.version}`
              : evaluation.detail,
            dataHex: evaluation.dataHex ?? null,
            blockHash: null,
            blockHeight: null,
            mempoolOnly: true,
            canonical: false,
            parserVersion: PARSER_VERSION,
          },
          ['txid'],
        );
      }
      await manager.delete(MempoolInputEntity, { txid: transaction.txid });
      const conflicts = new Set<string>();
      for (let vin = 0; vin < transaction.inputs.length; vin += 1) {
        const input = transaction.inputs[vin];
        if (!input?.txid || input.vout === undefined) continue;
        const competing = await manager
          .createQueryBuilder(MempoolInputEntity, 'input')
          .innerJoin(
            MempoolTransactionEntity,
            'mempool',
            'mempool.txid = input.txid AND mempool.status = :status',
            { status: 'active' },
          )
          .where('input.prev_txid = :prevTxid', { prevTxid: input.txid })
          .andWhere('input.prev_vout = :prevVout', { prevVout: input.vout })
          .andWhere('input.txid != :txid', { txid: transaction.txid })
          .getMany();
        for (const conflict of competing) {
          conflicts.add(conflict.txid);
          const pair = [conflict.txid, transaction.txid].sort();
          await manager
            .createQueryBuilder()
            .insert()
            .into(ConflictEntity)
            .values({
              prevTxid: input.txid,
              prevVout: input.vout,
              firstTxid: pair[0]!,
              secondTxid: pair[1]!,
              winnerTxid: null,
              status: 'open',
            })
            .orIgnore()
            .execute();
        }
        await manager.insert(MempoolInputEntity, {
          txid: transaction.txid,
          vin,
          prevTxid: input.txid,
          prevVout: input.vout,
          sequence: BigInt(input.sequence),
        });
      }
      return {
        txid: transaction.txid,
        protocolStatus,
        protocolCode,
        conflicts: [...conflicts].sort(),
      };
    });
    this.events.emit('witness.mempool', result);
    return result;
  }

  async reconcile(
    rpc: BitcoinRpcClient,
    handle: IndexerLeaseHandle,
    snapshot?: Record<string, RawMempoolEntry>,
  ): Promise<{ added: number; removed: number; replaced: number }> {
    const mempool = snapshot ?? (await rpc.getRawMempool());
    const nodeTxids = new Set(Object.keys(mempool));
    const local = await this.dataSource.manager.findBy(MempoolTransactionEntity, {
      status: In(['active', 'removed']),
    });
    const localByTxid = new Map(local.map((item) => [item.txid, item]));
    let added = 0;
    let removed = 0;
    let replaced = 0;

    for (const txid of [...nodeTxids].sort()) {
      const existing = localByTxid.get(txid);
      if (existing) {
        if (existing.status !== 'active') await this.setStatus(txid, 'active', handle);
        continue;
      }
      try {
        const transaction = await rpc.hydratePrevouts(await rpc.getRawTransaction(txid));
        await this.ingest(transaction, handle, mempool[txid]);
        added += 1;
      } catch (error) {
        if (error instanceof IndexerLeaseLostError) throw error;
        this.logger.warn({
          event: 'mempool_ingest_failed',
          txid,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const existing of local) {
      if (nodeTxids.has(existing.txid)) continue;
      const competitor = await this.findActiveCompetitor(existing.txid, nodeTxids);
      if (competitor) {
        await this.recordReplacement(existing.txid, competitor, 'shared-input-removed', handle);
        replaced += 1;
      } else {
        await this.setStatus(existing.txid, 'evicted', handle);
        removed += 1;
      }
    }
    await this.purgeExpired(handle);
    return { added, removed, replaced };
  }

  async markSequenceRemoval(txid: string, handle: IndexerLeaseHandle): Promise<void> {
    await this.lease.fencedTransaction(handle, 'READ COMMITTED', async (manager) => {
      await manager.update(
        MempoolTransactionEntity,
        { txid, status: 'active' },
        { status: 'removed' },
      );
    });
  }

  async confirm(transaction: BitcoinTransaction, handle: IndexerLeaseHandle): Promise<void> {
    await this.confirmBlock([transaction], handle);
  }

  async confirmBlock(
    transactions: BitcoinTransaction[],
    handle: IndexerLeaseHandle,
  ): Promise<void> {
    await this.lease.fencedTransaction(handle, 'READ COMMITTED', async (manager) => {
      const known = await manager.findBy(MempoolTransactionEntity, {
        txid: In(transactions.map(({ txid }) => txid)),
      });
      const knownIds = new Set(known.map(({ txid }) => txid));
      for (const transaction of transactions) {
        if (!knownIds.has(transaction.txid)) continue;
        await manager.update(
          MempoolTransactionEntity,
          { txid: transaction.txid },
          { status: 'confirmed' },
        );
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
              { txid: In(competing.map(({ txid }) => txid)) },
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
    });
  }

  private async findActiveCompetitor(txid: string, nodeTxids: Set<string>): Promise<string | null> {
    const conflicts = await this.dataSource.manager
      .createQueryBuilder(ConflictEntity, 'conflict')
      .where('conflict.status = :status', { status: 'open' })
      .andWhere('(conflict.first_txid = :txid OR conflict.second_txid = :txid)', { txid })
      .getMany();
    for (const conflict of conflicts) {
      const other = conflict.firstTxid === txid ? conflict.secondTxid : conflict.firstTxid;
      if (nodeTxids.has(other)) return other;
    }
    return null;
  }

  private async recordReplacement(
    oldTxid: string,
    newTxid: string,
    reason: string,
    handle: IndexerLeaseHandle,
  ): Promise<void> {
    await this.lease.fencedTransaction(handle, 'READ COMMITTED', async (manager) => {
      await manager.update(MempoolTransactionEntity, { txid: oldTxid }, { status: 'replaced' });
      await manager.upsert(ReplacementEntity, { oldTxid, newTxid, reason }, ['oldTxid', 'newTxid']);
      await manager
        .createQueryBuilder()
        .update(ConflictEntity)
        .set({ status: 'resolved', winnerTxid: newTxid, resolvedAt: new Date() })
        .where('status = :status AND (first_txid = :old OR second_txid = :old)', {
          status: 'open',
          old: oldTxid,
        })
        .execute();
    });
    this.events.emit('witness.replacement', { oldTxid, newTxid, reason });
  }

  private async setStatus(txid: string, status: string, handle: IndexerLeaseHandle): Promise<void> {
    await this.lease.fencedTransaction(handle, 'READ COMMITTED', async (manager) => {
      await manager.update(MempoolTransactionEntity, { txid }, { status });
    });
  }

  private async purgeExpired(handle: IndexerLeaseHandle): Promise<void> {
    await this.lease.fencedTransaction(handle, 'READ COMMITTED', async (manager) => {
      await manager.query(
        `DELETE FROM wc_mempool_transactions
         WHERE status IN ('evicted', 'conflicted', 'replaced', 'confirmed')
           AND last_seen_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY)`,
        [this.retentionDays],
      );
    });
  }

  private projection(
    evaluation: Awaited<ReturnType<WitnessStateEngine['evaluate']>>,
  ): Record<string, unknown> | null {
    if (evaluation.classification === 'none') {
      return evaluation.closures.length > 0
        ? { closures: evaluation.closures.map(({ lineageId }) => lineageId) }
        : null;
    }
    if (evaluation.classification === 'valid') {
      return {
        version: evaluation.envelope.version,
        network: evaluation.envelope.network,
        participantCount: evaluation.envelope.participantCount,
        contextHash: evaluation.envelope.contextHash,
        feeSats: evaluation.transition.feeSats.toString(),
        lineages: evaluation.transition.members.map(({ lineageId, fresh }) => ({
          lineageId,
          fresh,
        })),
      };
    }
    if (evaluation.classification === 'invalid') {
      return {
        code: evaluation.code,
        detail: evaluation.detail,
        dataHex: evaluation.dataHex,
        closures: evaluation.closures.map(({ lineageId }) => lineageId),
      };
    }
    return {
      version: evaluation.version,
      network: evaluation.networkByte,
      participantCount: evaluation.participantCount,
      contextHash: evaluation.contextHash,
      dataHex: evaluation.dataHex,
      closures: evaluation.closures.map(({ lineageId }) => lineageId),
    };
  }
}
