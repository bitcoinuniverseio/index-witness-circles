import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, In } from 'typeorm';
import { AppConfiguration } from '../config/configuration';
import {
  AdminJobEntity,
  BlockEntity,
  BlockUndoEntity,
  CheckpointEntity,
  CircleEdgeEntity,
  CircleEntity,
  CircleMemberEntity,
  IndexerVersionEntity,
  InvalidEventEntity,
  LineageClosureEntity,
  LineageEntity,
  ParserVersionEntity,
  ProtocolStatEntity,
  SearchDocumentEntity,
  ShardEntity,
  TransactionEntity,
  TransactionInputEntity,
  TransactionOutputEntity,
} from '../database/entities';
import {
  BitcoinBlock,
  BitcoinTransaction,
  CircleTransition,
  ClosureTransition,
  INDEXER_VERSION,
  LineageRecord,
  NETWORK_BY_NAME,
  PARSER_VERSION,
  SCHEMA_VERSION,
  ShardRecord,
  StateLookup,
  WitnessNetwork,
  WitnessStateEngine,
  outpointKey,
  parseWitnessScript,
  scriptHash,
} from '../protocol';
import { IndexerLeaseHandle, IndexerLeaseService } from './indexer-lease.service';

const EMPTY_STATE_ROOT = createHash('sha256').update('WITC/state/v1/empty').digest('hex');

interface LineageSnapshot {
  lineageId: string;
  genesisTxid: string;
  genesisVout: number;
  currentTxid: string | null;
  currentVout: number | null;
  currentValueSats: string | null;
  currentScriptHash: string | null;
  currentAddress: string | null;
  status: string;
  firstHeight: number;
  lastHeight: number;
  circleCount: number;
  lastCircleTxid: string | null;
  closedByTxid: string | null;
}

interface ShardSnapshot {
  txid: string;
  vout: number;
  lineageId: string;
  valueSats: string;
  scriptHex: string;
  scriptHash: string;
  address: string | null;
  status: string;
  createdCircleTxid: string;
  createdHeight: number;
  previousTxid: string | null;
  previousVout: number | null;
  spentByTxid: string | null;
  spentByVin: number | null;
  spentHeight: number | null;
}

interface OutputSnapshot {
  txid: string;
  vout: number;
  spentByTxid: string | null;
  spentByVin: number | null;
  spentHeight: number | null;
  shardLineageId: string | null;
}

interface BlockUndoDocument {
  version: 1;
  lineages: LineageSnapshot[];
  shards: ShardSnapshot[];
  outputs: OutputSnapshot[];
  newLineageIds: string[];
  newShards: Array<{ txid: string; vout: number }>;
  circleTxids: string[];
  closures: Array<{ spendingTxid: string; lineageId: string }>;
  invalidTxids: string[];
}

interface UndoCollector {
  document: BlockUndoDocument;
  lineageKeys: Set<string>;
  shardKeys: Set<string>;
  outputKeys: Set<string>;
  newLineages: Set<string>;
  newShards: Set<string>;
}

export interface ProcessBlockResult {
  hash: string;
  height: number;
  transactions: number;
  circles: Array<Record<string, unknown>>;
  closures: Array<Record<string, unknown>>;
  invalid: number;
  stateRoot: string;
}

export interface VerifyStateResult {
  ok: boolean;
  expectedStateRoot: string | null;
  actualStateRoot: string;
  checkpoint: CheckpointEntity | null;
  counts: Record<string, number>;
}

@Injectable()
export class DatabaseStateLookup implements StateLookup {
  private readonly shardCache = new Map<string, ShardRecord | null>();
  private readonly lineageCache = new Map<string, LineageRecord | null>();
  private readonly prefetchedTxids = new Set<string>();

  constructor(private readonly manager: EntityManager) {}

  async prefetch(transactionIds: string[]): Promise<void> {
    const ids = [...new Set(transactionIds.map((value) => value.toLowerCase()))];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      if (chunk.length === 0) continue;
      const shards = await this.manager.findBy(ShardEntity, { txid: In(chunk) });
      for (const txid of chunk) this.prefetchedTxids.add(txid);
      for (const shard of shards)
        this.shardCache.set(outpointKey(shard), this.toShardRecord(shard));
    }
  }

  async shardByOutpoint(outpoint: { txid: string; vout: number }): Promise<ShardRecord | null> {
    const key = outpointKey(outpoint);
    if (this.shardCache.has(key)) return this.shardCache.get(key) ?? null;
    if (this.prefetchedTxids.has(outpoint.txid.toLowerCase())) {
      this.shardCache.set(key, null);
      return null;
    }
    const shard = await this.manager.findOneBy(ShardEntity, {
      txid: outpoint.txid.toLowerCase(),
      vout: outpoint.vout,
    });
    const record = shard ? this.toShardRecord(shard) : null;
    this.shardCache.set(key, record);
    return record;
  }

  async lineageById(lineageId: string): Promise<LineageRecord | null> {
    if (this.lineageCache.has(lineageId)) return this.lineageCache.get(lineageId) ?? null;
    const lineage = await this.manager.findOneBy(LineageEntity, { lineageId });
    const record = lineage ? this.toLineageRecord(lineage) : null;
    this.lineageCache.set(lineageId, record);
    return record;
  }

  rememberShard(shard: ShardEntity): void {
    this.shardCache.set(outpointKey(shard), this.toShardRecord(shard));
  }

  forgetShard(txid: string, vout: number): void {
    this.shardCache.set(outpointKey({ txid, vout }), null);
  }

  rememberLineage(lineage: LineageEntity): void {
    this.lineageCache.set(lineage.lineageId, this.toLineageRecord(lineage));
  }

  private toShardRecord(shard: ShardEntity): ShardRecord {
    return {
      txid: shard.txid,
      vout: shard.vout,
      lineageId: shard.lineageId,
      valueSats: shard.valueSats,
      scriptPubKeyHex: shard.scriptHex,
      scriptHash: shard.scriptHash,
      address: shard.address,
      status: shard.status as ShardRecord['status'],
      createdCircleTxid: shard.createdCircleTxid,
      previousTxid: shard.previousTxid,
      previousVout: shard.previousVout,
    };
  }

  private toLineageRecord(lineage: LineageEntity): LineageRecord {
    return {
      id: lineage.lineageId,
      genesisTxid: lineage.genesisTxid,
      genesisVout: lineage.genesisVout,
      currentTxid: lineage.currentTxid,
      currentVout: lineage.currentVout,
      status: lineage.status as LineageRecord['status'],
      circleCount: lineage.circleCount,
      lastCircleTxid: lineage.lastCircleTxid,
    };
  }
}

@Injectable()
export class IndexerStore {
  readonly network: WitnessNetwork;
  readonly startHeight: number;

  constructor(
    private readonly dataSource: DataSource,
    configService: ConfigService<AppConfiguration, true>,
    private readonly engine: WitnessStateEngine,
    private readonly lease: IndexerLeaseService,
  ) {
    const networkName = configService.get('network', { infer: true });
    this.network = NETWORK_BY_NAME[networkName];
    this.startHeight = configService.get('indexer', { infer: true }).startHeight;
  }

  getCheckpoint(): Promise<CheckpointEntity | null> {
    return this.dataSource.manager.findOneBy(CheckpointEntity, { id: 'canonical' });
  }

  async ensureCheckpoint(
    boundaryParentHash: string | null,
    handle: IndexerLeaseHandle,
  ): Promise<CheckpointEntity> {
    return this.lease.fencedTransaction(handle, 'SERIALIZABLE', async (manager) => {
      const existing = await manager.findOneBy(CheckpointEntity, { id: 'canonical' });
      if (existing) return existing;
      await manager.upsert(
        IndexerVersionEntity,
        {
          version: INDEXER_VERSION,
          gitCommit: process.env.WITNESS_SOURCE_REVISION ?? null,
          schemaVersion: SCHEMA_VERSION,
        },
        ['version'],
      );
      await manager.upsert(
        ParserVersionEntity,
        { parserVersion: PARSER_VERSION, protocolVersion: 1, implementationHash: null },
        ['parserVersion'],
      );
      return manager.save(
        CheckpointEntity,
        manager.create(CheckpointEntity, {
          id: 'canonical',
          network: this.network,
          startHeight: this.startHeight,
          tipHeight: this.startHeight - 1,
          tipHash: boundaryParentHash,
          boundaryParentHash,
          stateRoot: EMPTY_STATE_ROOT,
          indexerVersion: INDEXER_VERSION,
          parserVersion: PARSER_VERSION,
          status: 'ready',
          lastError: null,
        }),
      );
    });
  }

  async processBlock(block: BitcoinBlock, handle: IndexerLeaseHandle): Promise<ProcessBlockResult> {
    return this.lease.fencedTransaction(handle, 'SERIALIZABLE', async (manager) => {
      const checkpoint = await manager.findOne(CheckpointEntity, {
        where: { id: 'canonical' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!checkpoint) throw new Error('Checkpoint is not initialized');
      this.assertNextBlock(block, checkpoint);
      const checkpointBefore = this.checkpointProjection(checkpoint);
      const undo = this.createUndo();
      await manager.upsert(
        BlockEntity,
        {
          hash: block.hash,
          height: block.height,
          previousHash: block.previousBlockHash,
          time: BigInt(block.time),
          medianTime: BigInt(block.medianTime),
          txCount: block.transactions.length,
          parserVersion: PARSER_VERSION,
          canonical: true,
        },
        ['hash'],
      );

      const lookup = new DatabaseStateLookup(manager);
      await lookup.prefetch(
        block.transactions.flatMap((transaction) =>
          transaction.inputs.flatMap((input) => (input.txid ? [input.txid] : [])),
        ),
      );
      const circles: Array<Record<string, unknown>> = [];
      const closures: Array<Record<string, unknown>> = [];
      let invalid = 0;
      for (let position = 0; position < block.transactions.length; position += 1) {
        const transaction = block.transactions[position]!;
        const result = await this.processTransaction(
          manager,
          lookup,
          block,
          transaction,
          position,
          undo,
        );
        if (result.circle) circles.push(result.circle);
        closures.push(...result.closures);
        if (result.invalid) invalid += 1;
      }

      const stateRoot = await this.computeStateRoot(manager);
      await manager.update(
        CircleEntity,
        { blockHash: block.hash, canonical: true },
        { stateRootAfter: stateRoot },
      );
      checkpoint.tipHeight = block.height;
      checkpoint.tipHash = block.hash;
      checkpoint.stateRoot = stateRoot;
      checkpoint.status = 'ready';
      checkpoint.lastError = null;
      checkpoint.indexerVersion = INDEXER_VERSION;
      checkpoint.parserVersion = PARSER_VERSION;
      await manager.save(checkpoint);
      await manager.upsert(
        BlockUndoEntity,
        {
          blockHash: block.hash,
          height: block.height,
          undoJson: undo.document as never,
          stateRootBefore: String(checkpointBefore.stateRoot),
          checkpointJsonBefore: checkpointBefore as never,
        },
        ['blockHash'],
      );
      await this.recomputeStats(manager);
      return {
        hash: block.hash,
        height: block.height,
        transactions: block.transactions.length,
        circles,
        closures,
        invalid,
        stateRoot,
      };
    });
  }

  async rollbackToHeight(targetHeight: number, handle: IndexerLeaseHandle): Promise<number> {
    if (targetHeight < this.startHeight - 1) {
      throw new Error('Rollback target precedes the configured index boundary');
    }
    let rolledBack = 0;
    while (true) {
      const checkpoint = await this.getCheckpoint();
      if (!checkpoint || checkpoint.tipHeight <= targetHeight) break;
      await this.rollbackTip(handle);
      rolledBack += 1;
    }
    return rolledBack;
  }

  async rollbackTip(handle: IndexerLeaseHandle): Promise<void> {
    await this.lease.fencedTransaction(handle, 'SERIALIZABLE', async (manager) => {
      const checkpoint = await manager.findOne(CheckpointEntity, {
        where: { id: 'canonical' },
        lock: { mode: 'pessimistic_write' },
      });
      if (!checkpoint?.tipHash || checkpoint.tipHeight < this.startHeight) {
        throw new Error('There is no indexed block to roll back');
      }
      const blockHash = checkpoint.tipHash;
      const undoEntity = await manager.findOneBy(BlockUndoEntity, { blockHash });
      if (!undoEntity) throw new Error(`Missing undo record for block ${blockHash}`);
      const undo = undoEntity.undoJson as unknown as BlockUndoDocument;
      if (undo.version !== 1) throw new Error('Unsupported block undo version');

      for (const snapshot of undo.outputs) {
        await manager.update(
          TransactionOutputEntity,
          { txid: snapshot.txid, vout: snapshot.vout },
          {
            spentByTxid: snapshot.spentByTxid,
            spentByVin: snapshot.spentByVin,
            spentHeight: snapshot.spentHeight,
            shardLineageId: snapshot.shardLineageId,
          },
        );
      }
      for (const shard of [...undo.newShards].reverse()) {
        await manager.delete(ShardEntity, shard);
      }
      for (const snapshot of undo.shards) await this.restoreShard(manager, snapshot);
      for (const snapshot of undo.lineages) await this.restoreLineage(manager, snapshot);
      for (const lineageId of [...undo.newLineageIds].reverse()) {
        await manager.delete(LineageEntity, { lineageId });
      }
      if (undo.circleTxids.length > 0) {
        await manager.update(
          CircleEntity,
          { circleTxid: In(undo.circleTxids) },
          { canonical: false, status: 'orphaned' },
        );
        await manager.update(
          CircleEdgeEntity,
          { toCircleTxid: In(undo.circleTxids) },
          { canonical: false },
        );
      }
      for (const closure of undo.closures) {
        await manager.update(LineageClosureEntity, closure, { canonical: false });
      }
      if (undo.invalidTxids.length > 0) {
        await manager.update(
          InvalidEventEntity,
          { txid: In(undo.invalidTxids) },
          { canonical: false },
        );
      }
      await manager.update(
        TransactionEntity,
        { blockHash },
        { canonical: false, confirmed: false },
      );
      await manager.update(BlockEntity, { hash: blockHash }, { canonical: false });

      const previous = undoEntity.checkpointJsonBefore;
      checkpoint.tipHeight = Number(previous.tipHeight);
      checkpoint.tipHash = this.optionalHash(previous.tipHash, 'tipHash');
      checkpoint.boundaryParentHash = this.optionalHash(
        previous.boundaryParentHash,
        'boundaryParentHash',
      );
      checkpoint.stateRoot = undoEntity.stateRootBefore;
      checkpoint.status = 'ready';
      checkpoint.lastError = null;
      await manager.save(checkpoint);
      const actual = await this.computeStateRoot(manager);
      if (actual !== checkpoint.stateRoot) {
        throw new Error(
          `Undo state root mismatch at height ${checkpoint.tipHeight}: ${actual} != ${checkpoint.stateRoot}`,
        );
      }
      await this.rebuildSearch(manager);
      await this.recomputeStats(manager);
    });
  }

  async verifyState(): Promise<VerifyStateResult> {
    const checkpoint = await this.getCheckpoint();
    const actualStateRoot = await this.computeStateRoot(this.dataSource.manager);
    const rows = (await this.dataSource.query(
      `SELECT
        (SELECT COUNT(*) FROM wc_circles WHERE canonical = TRUE) AS circles,
        (SELECT COUNT(*) FROM wc_lineages) AS lineages,
        (SELECT COUNT(*) FROM wc_shards WHERE status = 'active') AS activeShards,
        (SELECT COUNT(*) FROM wc_invalid_events WHERE canonical = TRUE) AS invalidEvents`,
    )) as Array<Record<string, string | number>>;
    const row = rows[0] ?? {};
    return {
      ok: checkpoint !== null && checkpoint.stateRoot === actualStateRoot,
      expectedStateRoot: checkpoint?.stateRoot ?? null,
      actualStateRoot,
      checkpoint,
      counts: Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])),
    };
  }

  async rebuildDerivedData(handle: IndexerLeaseHandle): Promise<void> {
    await this.lease.fencedTransaction(handle, 'SERIALIZABLE', async (manager) => {
      await this.rebuildSearch(manager);
      await this.recomputeStats(manager);
    });
  }

  async setBoundaryParentHash(
    boundaryParentHash: string | null,
    handle: IndexerLeaseHandle,
  ): Promise<void> {
    await this.lease.fencedTransaction(handle, 'READ COMMITTED', async (manager) => {
      await manager.update(
        CheckpointEntity,
        { id: 'canonical' },
        { boundaryParentHash, tipHash: boundaryParentHash },
      );
    });
  }

  async markCheckpointError(error: unknown, handle: IndexerLeaseHandle): Promise<void> {
    await this.lease.fencedTransaction(handle, 'READ COMMITTED', async (manager) => {
      await manager.update(
        CheckpointEntity,
        { id: 'canonical' },
        {
          status: 'error',
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 4_096),
        },
      );
    });
  }

  async getCanonicalBlockHash(height: number): Promise<string | null> {
    const block = await this.dataSource.manager.findOne(BlockEntity, {
      where: { height, canonical: true },
    });
    return block?.hash ?? null;
  }

  async createAdminJob(
    job: Pick<AdminJobEntity, 'id' | 'kind' | 'fromHeight' | 'toHeight'>,
  ): Promise<void> {
    await this.dataSource.manager.insert(AdminJobEntity, {
      ...job,
      status: 'running',
      resultJson: null,
      errorText: null,
      completedAt: null,
    });
  }

  async finishAdminJob(
    id: string,
    result: Record<string, unknown> | null,
    error: string | null,
  ): Promise<void> {
    await this.dataSource.manager.update(
      AdminJobEntity,
      { id },
      {
        status: error ? 'failed' : 'complete',
        resultJson: result as never,
        errorText: error,
        completedAt: new Date(),
      },
    );
  }

  private async processTransaction(
    manager: EntityManager,
    lookup: DatabaseStateLookup,
    block: BitcoinBlock,
    transaction: BitcoinTransaction,
    position: number,
    undo: UndoCollector,
  ): Promise<{
    circle: Record<string, unknown> | null;
    closures: Array<Record<string, unknown>>;
    invalid: boolean;
  }> {
    const feeSats = this.transactionFee(transaction);
    await manager.upsert(
      TransactionEntity,
      {
        txid: transaction.txid,
        wtxid: transaction.wtxid ?? null,
        blockHash: block.hash,
        blockHeight: block.height,
        position,
        version: transaction.version,
        locktime: transaction.locktime,
        size: transaction.size ?? null,
        vsize: transaction.vsize ?? null,
        weight: transaction.weight ?? null,
        feeSats,
        rawHex: transaction.hex ?? null,
        canonical: true,
        confirmed: true,
      },
      ['txid'],
    );

    for (let vin = 0; vin < transaction.inputs.length; vin += 1) {
      const input = transaction.inputs[vin]!;
      const prevScript = input.prevout?.scriptPubKeyHex ?? null;
      await manager.upsert(
        TransactionInputEntity,
        {
          txid: transaction.txid,
          vin,
          prevTxid: input.txid ?? null,
          prevVout: input.vout ?? null,
          sequence: BigInt(input.sequence),
          coinbase: input.coinbase ?? null,
          witnessJson: input.witness,
          prevValueSats: input.prevout?.valueSats ?? null,
          prevScriptHex: prevScript,
          prevScriptHash: prevScript ? scriptHash(prevScript) : null,
          prevAddress: input.prevout?.address ?? null,
          prevBlockHeight: input.prevout?.blockHeight ?? null,
        },
        ['txid', 'vin'],
      );
      if (input.txid && input.vout !== undefined) {
        await this.captureAndMarkOutputSpend(
          manager,
          undo,
          input.txid,
          input.vout,
          transaction.txid,
          vin,
          block.height,
        );
      }
    }
    for (let vout = 0; vout < transaction.outputs.length; vout += 1) {
      const output = transaction.outputs[vout]!;
      const parsed = parseWitnessScript(output.scriptPubKeyHex);
      await manager.upsert(
        TransactionOutputEntity,
        {
          txid: transaction.txid,
          vout,
          valueSats: output.valueSats,
          scriptHex: output.scriptPubKeyHex.toLowerCase(),
          scriptHash: scriptHash(output.scriptPubKeyHex),
          scriptType: output.type ?? null,
          address: output.address ?? null,
          isWitcMarker: parsed.kind !== 'not_protocol',
          shardLineageId: null,
          spentByTxid: null,
          spentByVin: null,
          spentHeight: null,
        },
        ['txid', 'vout'],
      );
    }

    const evaluation = await this.engine.evaluate(transaction, {
      network: this.network,
      blockHeight: block.height,
      confirmed: true,
      lookup,
    });
    let circle: Record<string, unknown> | null = null;
    let invalid = false;
    if (evaluation.classification === 'valid') {
      circle = await this.applyCircle(
        manager,
        lookup,
        block,
        position,
        transaction,
        evaluation.transition,
        undo,
      );
    } else if (evaluation.classification === 'invalid') {
      invalid = true;
      undo.document.invalidTxids.push(transaction.txid);
      await manager.upsert(
        InvalidEventEntity,
        {
          txid: transaction.txid,
          classification: 'invalid',
          errorCode: evaluation.code,
          detail: evaluation.detail,
          dataHex: evaluation.dataHex ?? null,
          blockHash: block.hash,
          blockHeight: block.height,
          mempoolOnly: false,
          canonical: true,
          parserVersion: PARSER_VERSION,
        },
        ['txid'],
      );
    } else if (evaluation.classification === 'observed') {
      undo.document.invalidTxids.push(transaction.txid);
      await manager.upsert(
        InvalidEventEntity,
        {
          txid: transaction.txid,
          classification: 'observed',
          errorCode: 'UNKNOWN_VERSION',
          detail: `Observed unsupported WITC version ${evaluation.version}`,
          dataHex: evaluation.dataHex,
          blockHash: block.hash,
          blockHeight: block.height,
          mempoolOnly: false,
          canonical: true,
          parserVersion: PARSER_VERSION,
        },
        ['txid'],
      );
    }

    const appliedClosures: Array<Record<string, unknown>> = [];
    if (evaluation.classification !== 'valid') {
      for (const closure of evaluation.closures) {
        appliedClosures.push(await this.applyClosure(manager, lookup, block, closure, undo));
      }
    }
    return { circle, closures: appliedClosures, invalid };
  }

  private async applyCircle(
    manager: EntityManager,
    lookup: DatabaseStateLookup,
    block: BitcoinBlock,
    position: number,
    transaction: BitcoinTransaction,
    transition: CircleTransition,
    undo: UndoCollector,
  ): Promise<Record<string, unknown>> {
    const circle = manager.create(CircleEntity, {
      circleTxid: transaction.txid,
      version: transition.envelope.version,
      network: transition.envelope.network,
      opcode: transition.envelope.opcode,
      participantCount: transition.members.length,
      contextHash: transition.envelope.contextHash,
      markerHex: transition.envelope.scriptHex,
      feeSats: transition.feeSats,
      freshLineages: transition.members.filter(({ fresh }) => fresh).length,
      status: 'confirmed',
      canonical: true,
      blockHash: block.hash,
      blockHeight: block.height,
      txPosition: position,
      confirmedAt: new Date(block.time * 1_000),
      stateRootAfter: null,
    });
    await manager.upsert(CircleEntity, circle, ['circleTxid']);
    undo.document.circleTxids.push(transaction.txid);

    for (const member of transition.members) {
      let lineage = await manager.findOneBy(LineageEntity, { lineageId: member.lineageId });
      const oldShard = await manager.findOneBy(ShardEntity, {
        txid: member.input.txid,
        vout: member.input.vout,
      });
      if (lineage) this.captureLineage(undo, lineage);
      if (oldShard) this.captureShard(undo, oldShard);
      const successorHash = scriptHash(member.output.scriptPubKeyHex);
      if (!lineage) {
        lineage = manager.create(LineageEntity, {
          lineageId: member.lineageId,
          genesisTxid: member.input.txid,
          genesisVout: member.input.vout,
          currentTxid: transaction.txid,
          currentVout: member.outputVout,
          currentValueSats: member.output.valueSats,
          currentScriptHash: successorHash,
          currentAddress: member.output.address ?? null,
          status: 'active',
          firstHeight: block.height,
          lastHeight: block.height,
          circleCount: 1,
          lastCircleTxid: transaction.txid,
          closedByTxid: null,
        });
        await manager.insert(LineageEntity, lineage);
        undo.newLineages.add(lineage.lineageId);
        undo.document.newLineageIds.push(lineage.lineageId);
      } else {
        lineage.currentTxid = transaction.txid;
        lineage.currentVout = member.outputVout;
        lineage.currentValueSats = member.output.valueSats;
        lineage.currentScriptHash = successorHash;
        lineage.currentAddress = member.output.address ?? null;
        lineage.status = 'active';
        lineage.lastHeight = block.height;
        lineage.circleCount += 1;
        lineage.lastCircleTxid = transaction.txid;
        lineage.closedByTxid = null;
        await manager.save(lineage);
      }
      lookup.rememberLineage(lineage);

      if (oldShard) {
        oldShard.status = 'spent';
        oldShard.spentByTxid = transaction.txid;
        oldShard.spentByVin = member.inputVin;
        oldShard.spentHeight = block.height;
        await manager.save(oldShard);
        lookup.rememberShard(oldShard);
      }
      const shard = manager.create(ShardEntity, {
        txid: transaction.txid,
        vout: member.outputVout,
        lineageId: member.lineageId,
        valueSats: member.output.valueSats,
        scriptHex: member.output.scriptPubKeyHex.toLowerCase(),
        scriptHash: successorHash,
        address: member.output.address ?? null,
        status: 'active',
        createdCircleTxid: transaction.txid,
        createdHeight: block.height,
        previousTxid: oldShard?.txid ?? null,
        previousVout: oldShard?.vout ?? null,
        spentByTxid: null,
        spentByVin: null,
        spentHeight: null,
      });
      const priorNewShard = await manager.findOneBy(ShardEntity, {
        txid: shard.txid,
        vout: shard.vout,
      });
      if (priorNewShard) this.captureShard(undo, priorNewShard);
      else {
        undo.newShards.add(outpointKey(shard));
        undo.document.newShards.push({ txid: shard.txid, vout: shard.vout });
      }
      await manager.upsert(ShardEntity, shard, ['txid', 'vout']);
      lookup.rememberShard(shard);
      await manager.update(
        TransactionOutputEntity,
        { txid: transaction.txid, vout: member.outputVout },
        { shardLineageId: member.lineageId },
      );
      await manager.upsert(
        CircleMemberEntity,
        {
          circleTxid: transaction.txid,
          slot: member.slot,
          lineageId: member.lineageId,
          inputTxid: member.input.txid,
          inputVout: member.input.vout,
          inputValueSats: member.input.prevout.valueSats,
          outputVout: member.outputVout,
          outputValueSats: member.output.valueSats,
          feeShareSats: member.feeShareSats,
          scriptHash: successorHash,
          address: member.output.address ?? null,
          fresh: member.fresh,
          previousCircleTxid: member.previousCircleTxid,
          blockHeight: block.height,
        },
        ['circleTxid', 'slot'],
      );
      if (member.previousCircleTxid && oldShard) {
        await manager.upsert(
          CircleEdgeEntity,
          {
            fromCircleTxid: member.previousCircleTxid,
            toCircleTxid: transaction.txid,
            lineageId: member.lineageId,
            viaTxid: oldShard.txid,
            viaVout: oldShard.vout,
            canonical: true,
            blockHeight: block.height,
          },
          ['fromCircleTxid', 'toCircleTxid', 'lineageId', 'viaTxid', 'viaVout'],
        );
      }
    }
    await this.upsertCircleSearch(manager, circle);
    return {
      txid: transaction.txid,
      participantCount: transition.members.length,
      contextHash: transition.envelope.contextHash,
      feeSats: transition.feeSats,
      blockHeight: block.height,
    };
  }

  private async applyClosure(
    manager: EntityManager,
    lookup: DatabaseStateLookup,
    block: BitcoinBlock,
    closure: ClosureTransition,
    undo: UndoCollector,
  ): Promise<Record<string, unknown>> {
    const lineage = await manager.findOneBy(LineageEntity, { lineageId: closure.lineageId });
    const shard = await manager.findOneBy(ShardEntity, {
      txid: closure.shard.txid,
      vout: closure.shard.vout,
    });
    if (!lineage || !shard || lineage.status !== 'active' || shard.status !== 'active') {
      return { lineageId: closure.lineageId, ignored: true };
    }
    this.captureLineage(undo, lineage);
    this.captureShard(undo, shard);
    lineage.status = 'closed';
    lineage.currentTxid = null;
    lineage.currentVout = null;
    lineage.currentValueSats = null;
    lineage.currentScriptHash = null;
    lineage.currentAddress = null;
    lineage.lastHeight = block.height;
    lineage.closedByTxid = closure.spendingTxid;
    shard.status = 'closed';
    shard.spentByTxid = closure.spendingTxid;
    shard.spentByVin = closure.spendingVin;
    shard.spentHeight = block.height;
    await manager.save(lineage);
    await manager.save(shard);
    lookup.rememberLineage(lineage);
    lookup.rememberShard(shard);
    await manager.upsert(
      LineageClosureEntity,
      {
        spendingTxid: closure.spendingTxid,
        lineageId: closure.lineageId,
        spendingVin: closure.spendingVin,
        shardTxid: closure.shard.txid,
        shardVout: closure.shard.vout,
        reason: closure.reason,
        blockHash: block.hash,
        blockHeight: block.height,
        canonical: true,
      },
      ['spendingTxid', 'lineageId'],
    );
    undo.document.closures.push({
      spendingTxid: closure.spendingTxid,
      lineageId: closure.lineageId,
    });
    await this.upsertLineageSearch(manager, lineage);
    return {
      lineageId: closure.lineageId,
      spendingTxid: closure.spendingTxid,
      reason: closure.reason,
      blockHeight: block.height,
    };
  }

  private async captureAndMarkOutputSpend(
    manager: EntityManager,
    undo: UndoCollector,
    txid: string,
    vout: number,
    spendingTxid: string,
    spendingVin: number,
    spentHeight: number,
  ): Promise<void> {
    const output = await manager.findOneBy(TransactionOutputEntity, { txid, vout });
    if (!output) return;
    const key = outpointKey(output);
    if (!undo.outputKeys.has(key)) {
      undo.outputKeys.add(key);
      undo.document.outputs.push({
        txid,
        vout,
        spentByTxid: output.spentByTxid,
        spentByVin: output.spentByVin,
        spentHeight: output.spentHeight,
        shardLineageId: output.shardLineageId,
      });
    }
    output.spentByTxid = spendingTxid;
    output.spentByVin = spendingVin;
    output.spentHeight = spentHeight;
    await manager.save(output);
  }

  private captureLineage(undo: UndoCollector, lineage: LineageEntity): void {
    if (undo.newLineages.has(lineage.lineageId) || undo.lineageKeys.has(lineage.lineageId)) return;
    undo.lineageKeys.add(lineage.lineageId);
    undo.document.lineages.push({
      lineageId: lineage.lineageId,
      genesisTxid: lineage.genesisTxid,
      genesisVout: lineage.genesisVout,
      currentTxid: lineage.currentTxid,
      currentVout: lineage.currentVout,
      currentValueSats: lineage.currentValueSats?.toString() ?? null,
      currentScriptHash: lineage.currentScriptHash,
      currentAddress: lineage.currentAddress,
      status: lineage.status,
      firstHeight: lineage.firstHeight,
      lastHeight: lineage.lastHeight,
      circleCount: lineage.circleCount,
      lastCircleTxid: lineage.lastCircleTxid,
      closedByTxid: lineage.closedByTxid,
    });
  }

  private captureShard(undo: UndoCollector, shard: ShardEntity): void {
    const key = outpointKey(shard);
    if (undo.newShards.has(key) || undo.shardKeys.has(key)) return;
    undo.shardKeys.add(key);
    undo.document.shards.push({
      txid: shard.txid,
      vout: shard.vout,
      lineageId: shard.lineageId,
      valueSats: shard.valueSats.toString(),
      scriptHex: shard.scriptHex,
      scriptHash: shard.scriptHash,
      address: shard.address,
      status: shard.status,
      createdCircleTxid: shard.createdCircleTxid,
      createdHeight: shard.createdHeight,
      previousTxid: shard.previousTxid,
      previousVout: shard.previousVout,
      spentByTxid: shard.spentByTxid,
      spentByVin: shard.spentByVin,
      spentHeight: shard.spentHeight,
    });
  }

  private restoreLineage(manager: EntityManager, snapshot: LineageSnapshot): Promise<unknown> {
    return manager.upsert(
      LineageEntity,
      {
        ...snapshot,
        currentValueSats:
          snapshot.currentValueSats === null ? null : BigInt(snapshot.currentValueSats),
      },
      ['lineageId'],
    );
  }

  private restoreShard(manager: EntityManager, snapshot: ShardSnapshot): Promise<unknown> {
    return manager.upsert(ShardEntity, { ...snapshot, valueSats: BigInt(snapshot.valueSats) }, [
      'txid',
      'vout',
    ]);
  }

  private async computeStateRoot(manager: EntityManager): Promise<string> {
    const hash = createHash('sha256').update('WITC/state/v1\n');
    const queries = [
      `SELECT circle_txid, participant_count, context_hash, fee_sats, block_height, tx_position
       FROM wc_circles WHERE canonical = TRUE ORDER BY block_height, tx_position, circle_txid`,
      `SELECT m.circle_txid, m.slot, m.lineage_id, m.input_txid, m.input_vout,
              m.input_value_sats, m.output_vout, m.output_value_sats, m.fee_share_sats, m.fresh
       FROM wc_circle_members m JOIN wc_circles c ON c.circle_txid = m.circle_txid
       WHERE c.canonical = TRUE ORDER BY m.circle_txid, m.slot`,
      `SELECT lineage_id, genesis_txid, genesis_vout, current_txid, current_vout,
              current_value_sats, current_script_hash, status, first_height, last_height,
              circle_count, last_circle_txid, closed_by_txid
       FROM wc_lineages ORDER BY lineage_id`,
      `SELECT txid, vout, lineage_id, value_sats, script_hash, status, created_circle_txid,
              created_height, previous_txid, previous_vout, spent_by_txid, spent_by_vin, spent_height
       FROM wc_shards ORDER BY txid, vout`,
      `SELECT spending_txid, lineage_id, spending_vin, shard_txid, shard_vout, reason, block_height
       FROM wc_lineage_closures WHERE canonical = TRUE ORDER BY block_height, spending_txid, lineage_id`,
    ];
    for (const query of queries) {
      const rows = (await manager.query(query)) as Array<Record<string, unknown>>;
      for (const row of rows) hash.update(JSON.stringify(row)).update('\n');
    }
    return hash.digest('hex');
  }

  private async recomputeStats(manager: EntityManager): Promise<void> {
    const rows = (await manager.query(
      `SELECT
        (SELECT COUNT(*) FROM wc_circles WHERE canonical = TRUE) AS circles,
        (SELECT COUNT(*) FROM wc_lineages) AS lineages,
        (SELECT COUNT(*) FROM wc_lineages WHERE status = 'active') AS activeLineages,
        (SELECT COUNT(*) FROM wc_shards WHERE status = 'active') AS activeShards,
        (SELECT COALESCE(SUM(participant_count), 0) FROM wc_circles WHERE canonical = TRUE)
          AS participantEvents,
        (SELECT COALESCE(SUM(fee_sats), 0) FROM wc_circles WHERE canonical = TRUE) AS totalFees,
        (SELECT COUNT(*) FROM wc_invalid_events WHERE canonical = TRUE) AS invalidEvents`,
    )) as Array<Record<string, string | number>>;
    const values = rows[0] ?? {};
    for (const [metricKey, value] of Object.entries(values)) {
      await manager.upsert(
        ProtocolStatEntity,
        { metricKey, scope: 'global', valueDecimal: String(value), valueJson: null },
        ['metricKey', 'scope'],
      );
    }
  }

  private async rebuildSearch(manager: EntityManager): Promise<void> {
    await manager.query('DELETE FROM wc_search_documents');
    const circles = await manager.findBy(CircleEntity, { canonical: true });
    for (const circle of circles) await this.upsertCircleSearch(manager, circle);
    const lineages = await manager.find(LineageEntity);
    for (const lineage of lineages) await this.upsertLineageSearch(manager, lineage);
  }

  private upsertCircleSearch(manager: EntityManager, circle: CircleEntity): Promise<unknown> {
    return manager.upsert(
      SearchDocumentEntity,
      {
        documentType: 'circle',
        documentId: circle.circleTxid,
        contextHash: circle.contextHash,
        title: `Witness Circle ${circle.circleTxid.slice(0, 12)}`,
        body: `${circle.circleTxid} ${circle.contextHash}`,
        sortHeight: circle.blockHeight,
      },
      ['documentType', 'documentId'],
    );
  }

  private upsertLineageSearch(manager: EntityManager, lineage: LineageEntity): Promise<unknown> {
    return manager.upsert(
      SearchDocumentEntity,
      {
        documentType: 'lineage',
        documentId: lineage.lineageId,
        contextHash: null,
        title: `Witness lineage ${lineage.lineageId.slice(0, 12)}`,
        body: `${lineage.lineageId} ${lineage.genesisTxid}`,
        sortHeight: lineage.lastHeight,
      },
      ['documentType', 'documentId'],
    );
  }

  private transactionFee(transaction: BitcoinTransaction): bigint | null {
    if (transaction.inputs.some((input) => !input.prevout)) return null;
    const inputs = transaction.inputs.reduce(
      (sum, input) => sum + (input.prevout?.valueSats ?? 0n),
      0n,
    );
    const outputs = transaction.outputs.reduce((sum, output) => sum + output.valueSats, 0n);
    return inputs >= outputs ? inputs - outputs : null;
  }

  private assertNextBlock(block: BitcoinBlock, checkpoint: CheckpointEntity): void {
    if (block.height !== checkpoint.tipHeight + 1) {
      throw new Error(`Expected block ${checkpoint.tipHeight + 1}, got ${block.height}`);
    }
    const expectedParent =
      checkpoint.tipHeight < this.startHeight ? checkpoint.boundaryParentHash : checkpoint.tipHash;
    if (block.previousBlockHash !== expectedParent) {
      throw new Error(
        `Block ${block.height} parent ${block.previousBlockHash} does not match ${expectedParent}`,
      );
    }
  }

  private checkpointProjection(checkpoint: CheckpointEntity): Record<string, unknown> {
    return {
      tipHeight: checkpoint.tipHeight,
      tipHash: checkpoint.tipHash,
      boundaryParentHash: checkpoint.boundaryParentHash,
      stateRoot: checkpoint.stateRoot,
      status: checkpoint.status,
    };
  }

  private createUndo(): UndoCollector {
    return {
      document: {
        version: 1,
        lineages: [],
        shards: [],
        outputs: [],
        newLineageIds: [],
        newShards: [],
        circleTxids: [],
        closures: [],
        invalidTxids: [],
      },
      lineageKeys: new Set(),
      shardKeys: new Set(),
      outputKeys: new Set(),
      newLineages: new Set(),
      newShards: new Set(),
    };
  }

  private optionalHash(value: unknown, field: string): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
      throw new Error(`Undo checkpoint ${field} is invalid`);
    }
    return value;
  }
}
