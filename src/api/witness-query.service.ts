import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, In } from 'typeorm';
import { BitcoinRpcClient } from '../bitcoin/bitcoin-rpc.client';
import { decodeRawTransaction } from '../bitcoin/raw-transaction';
import { AppConfiguration } from '../config/configuration';
import {
  CheckpointEntity,
  CircleEdgeEntity,
  CircleEntity,
  CircleMemberEntity,
  LineageClosureEntity,
  LineageEntity,
  MempoolTransactionEntity,
  ProtocolStatEntity,
  ShardEntity,
  TransactionEntity,
} from '../database/entities';
import { INDEXER_VERSION, NETWORK_BY_NAME, PARSER_VERSION, WitnessStateEngine } from '../protocol';
import { DatabaseStateLookup, IndexerStore } from '../indexer/indexer.store';
import { SyncStatusService } from '../indexer/sync-status.service';
import {
  CirclesQueryDto,
  CursorPaginationDto,
  FeesQueryDto,
  GraphQueryDto,
  InvalidEventsQueryDto,
  LineagesQueryDto,
  LineageHistoryQueryDto,
  MempoolQueryDto,
  SafetyOutpointDto,
  SearchQueryDto,
  TrendingQueryDto,
} from './query.dto';

interface CircleCursor {
  height: number;
  position: number;
  txid: string;
}

interface LineageCursor {
  height: number;
  id: string;
}

interface PositionCursor {
  height: number;
  position: number;
  txid: string;
}

interface ActivityCursor extends PositionCursor {
  key: string;
}

interface TimeCursor {
  time: string;
  txid: string;
}

const CORE_CHAIN_BY_NETWORK: Record<AppConfiguration['network'], string> = {
  mainnet: 'main',
  testnet3: 'test',
  signet: 'signet',
  regtest: 'regtest',
};
const MAX_SAFETY_MEMPOOL_TRANSACTIONS = 100_000;

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor<T>(cursor: string | undefined): T | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

function assertHex64(value: string, label: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(value))
    throw new BadRequestException(`${label} must be 32-byte hex`);
  return value.toLowerCase();
}

function decodePositionCursor(cursor: string | undefined, label: string): PositionCursor | null {
  const decoded = decodeCursor<PositionCursor>(cursor);
  if (
    decoded &&
    (!Number.isInteger(decoded.height) ||
      decoded.height < 0 ||
      !Number.isInteger(decoded.position) ||
      decoded.position < 0 ||
      !/^[0-9a-f]{64}$/.test(decoded.txid))
  ) {
    throw new BadRequestException(`Invalid ${label} cursor`);
  }
  return decoded;
}

function decodeActivityCursor(cursor: string | undefined): ActivityCursor | null {
  const decoded = decodeCursor<ActivityCursor>(cursor);
  if (
    decoded &&
    (!Number.isInteger(decoded.height) ||
      decoded.height < 0 ||
      !Number.isInteger(decoded.position) ||
      decoded.position < 0 ||
      !/^[0-9a-f]{64}$/.test(decoded.txid) ||
      !/^[cx]:[0-9a-f]{64}$/.test(decoded.key))
  ) {
    throw new BadRequestException('Invalid address activity cursor');
  }
  return decoded;
}

function decodeTimeCursor(cursor: string | undefined, label: string): TimeCursor | null {
  const decoded = decodeCursor<TimeCursor>(cursor);
  if (
    decoded &&
    (typeof decoded.time !== 'string' ||
      Number.isNaN(Date.parse(decoded.time)) ||
      !/^[0-9a-f]{64}$/.test(decoded.txid))
  ) {
    throw new BadRequestException(`Invalid ${label} cursor`);
  }
  return decoded;
}

function isoTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('Database returned an invalid timestamp');
  return date.toISOString();
}

function databaseDecimal(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  throw new Error(`Database returned an invalid ${field}`);
}

async function queryRecords(
  dataSource: DataSource,
  sql: string,
  parameters: unknown[] = [],
): Promise<Array<Record<string, unknown>>> {
  const result: unknown = await dataSource.query(sql, parameters);
  if (!Array.isArray(result)) throw new Error('Database query did not return rows');
  return result as Array<Record<string, unknown>>;
}

@Injectable()
export class WitnessQueryService {
  private readonly networkName: AppConfiguration['network'];
  private readonly settledConfirmations: number;
  private readonly mempoolFreshMs: number;

  constructor(
    private readonly dataSource: DataSource,
    private readonly rpc: BitcoinRpcClient,
    private readonly store: IndexerStore,
    private readonly engine: WitnessStateEngine,
    private readonly syncStatus: SyncStatusService,
    configService: ConfigService<AppConfiguration, true>,
  ) {
    this.networkName = configService.get('network', { infer: true });
    const indexer = configService.get('indexer', { infer: true });
    this.settledConfirmations = indexer.confirmations;
    this.mempoolFreshMs = Math.max(5_000, Math.min(60_000, indexer.mempoolPollMs * 3));
  }

  async status(): Promise<Record<string, unknown>> {
    const checkpoint = await this.store.getCheckpoint();
    const runtime = this.syncStatus.snapshot();
    const counts = (await this.dataSource.query(
      `SELECT
        (SELECT COUNT(*) FROM wc_circles WHERE canonical = TRUE) AS circles,
        (SELECT COUNT(*) FROM wc_lineages) AS lineages,
        (SELECT COUNT(*) FROM wc_shards WHERE status = 'active') AS activeShards,
        (SELECT COUNT(*) FROM wc_mempool_transactions WHERE status = 'active') AS mempoolActive,
        (SELECT COUNT(*) FROM wc_mempool_transactions WHERE status = 'active' AND protocol_status = 'valid') AS mempoolValid,
        (SELECT COUNT(*) FROM wc_mempool_transactions WHERE status = 'active' AND protocol_status = 'invalid') AS mempoolInvalid`,
    )) as Array<Record<string, string | number>>;
    let nodeHeight: number | null = null;
    let nodeHash: string | null = null;
    let nodeError: string | null = null;
    try {
      const info = await this.rpc.getBlockchainInfo();
      nodeHeight = info.blocks;
      nodeHash = info.bestblockhash;
    } catch (error) {
      nodeError = error instanceof Error ? error.message : String(error);
    }
    const indexedHeight = checkpoint?.tipHeight ?? this.store.startHeight - 1;
    const indexedHash = checkpoint?.tipHash ?? null;
    const synced =
      runtime.initialized &&
      runtime.ready &&
      !runtime.syncing &&
      runtime.lastError === null &&
      nodeHeight !== null &&
      nodeHash !== null &&
      indexedHeight === nodeHeight &&
      indexedHash === nodeHash;
    const row = counts[0] ?? {};
    return {
      protocol: 'WITC',
      version: '1',
      indexerVersion: INDEXER_VERSION,
      parserVersion: PARSER_VERSION,
      network: this.networkName,
      networkByte: NETWORK_BY_NAME[this.networkName],
      startHeight: this.store.startHeight,
      indexedHeight,
      indexedHash,
      nodeHeight,
      nodeHash,
      lag: nodeHeight === null ? null : Math.max(0, nodeHeight - indexedHeight),
      synced,
      settledConfirmations: this.settledConfirmations,
      stateRoot: checkpoint?.stateRoot ?? null,
      nodeError,
      runtime,
      mempool: {
        active: Number(row.mempoolActive ?? 0),
        valid: Number(row.mempoolValid ?? 0),
        invalid: Number(row.mempoolInvalid ?? 0),
      },
      counts: {
        circles: Number(row.circles ?? 0),
        lineages: Number(row.lineages ?? 0),
        activeShards: Number(row.activeShards ?? 0),
      },
    };
  }

  async circles(query: CirclesQueryDto): Promise<Record<string, unknown>> {
    const cursor = decodeCursor<CircleCursor>(query.cursor);
    if (
      cursor &&
      (!Number.isInteger(cursor.height) ||
        !Number.isInteger(cursor.position) ||
        !/^[0-9a-f]{64}$/.test(cursor.txid))
    ) {
      throw new BadRequestException('Invalid circle cursor');
    }
    const recent = query.sort !== 'oldest';
    const parameters: unknown[] = [query.status === 'confirmed'];
    let filters = 'c.canonical = ?';
    if (query.participantCount !== undefined) {
      filters += ' AND c.participant_count = ?';
      parameters.push(query.participantCount);
    }
    if (query.contextHash) {
      filters += ' AND c.context_hash = ?';
      parameters.push(query.contextHash.toLowerCase());
    }
    if (cursor) {
      filters += recent
        ? ' AND (c.block_height, c.tx_position, c.circle_txid) < (?, ?, ?)'
        : ' AND (c.block_height, c.tx_position, c.circle_txid) > (?, ?, ?)';
      parameters.push(cursor.height, cursor.position, cursor.txid);
    }
    parameters.push(query.limit + 1);
    const rows = (await this.dataSource.query(
      `SELECT c.circle_txid AS txid, t.wtxid, c.status, c.block_height AS blockHeight,
              c.block_hash AS blockHash, c.tx_position AS txPosition,
              c.confirmed_at AS confirmedAt, c.participant_count AS participantCount,
              c.context_hash AS contextHash, c.fee_sats AS feeSats, t.vsize,
              c.state_root_after AS stateRootAfter, c.fresh_lineages AS freshLineages
       FROM wc_circles c JOIN wc_transactions t ON t.txid = c.circle_txid
       WHERE ${filters}
       ORDER BY c.block_height ${recent ? 'DESC' : 'ASC'},
                c.tx_position ${recent ? 'DESC' : 'ASC'},
                c.circle_txid ${recent ? 'DESC' : 'ASC'} LIMIT ?`,
      parameters,
    )) as Array<Record<string, unknown>>;
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1) as Record<string, unknown> | undefined;
    return {
      items,
      limit: query.limit,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              height: Number(last.blockHeight),
              position: Number(last.txPosition),
              txid: String(last.txid),
            })
          : null,
    };
  }

  async circle(txidValue: string): Promise<Record<string, unknown>> {
    const txid = assertHex64(txidValue, 'txid');
    const circle = await this.dataSource.manager.findOneBy(CircleEntity, { circleTxid: txid });
    if (!circle) throw new NotFoundException('Witness Circle not found');
    const [transaction, members, edges, nodeHeight] = await Promise.all([
      this.dataSource.manager.findOneBy(TransactionEntity, { txid }),
      this.dataSource.manager.find(CircleMemberEntity, {
        where: { circleTxid: txid },
        order: { slot: 'ASC' },
      }),
      this.dataSource.manager.find(CircleEdgeEntity, {
        where: [{ fromCircleTxid: txid }, { toCircleTxid: txid }],
      }),
      this.rpc.getBlockCount().catch(() => null),
    ]);
    const outputs = (await this.dataSource.query(
      `SELECT vout, value_sats AS valueSats, script_hash AS scriptHash, address
       FROM wc_transaction_outputs WHERE txid = ?`,
      [txid],
    )) as Array<Record<string, unknown>>;
    const outputByVout = new Map(outputs.map((output) => [Number(output.vout), output]));
    return {
      circle: {
        txid: circle.circleTxid,
        wtxid: transaction?.wtxid ?? null,
        status: circle.status,
        canonical: circle.canonical,
        blockHeight: circle.blockHeight,
        blockHash: circle.blockHash,
        txPosition: circle.txPosition,
        confirmedAt: circle.confirmedAt,
        participantCount: circle.participantCount,
        contextHash: circle.contextHash,
        feeSats: circle.feeSats,
        vsize: transaction?.vsize ?? null,
        stateRootAfter: circle.stateRootAfter,
        freshLineages: circle.freshLineages,
        markerHex: circle.markerHex,
        version: circle.version,
        network: circle.network,
        opcode: circle.opcode,
      },
      members: members.map((member) => {
        const output = outputByVout.get(member.outputVout);
        return {
          slot: member.slot,
          lineageId: member.lineageId,
          input: {
            txid: member.inputTxid,
            vout: member.inputVout,
            valueSats: member.inputValueSats,
            scriptHash: member.scriptHash,
            address: member.address,
          },
          output: {
            txid,
            vout: member.outputVout,
            valueSats: member.outputValueSats,
            scriptHash: output?.scriptHash ?? member.scriptHash,
            address: output?.address ?? member.address,
          },
          feeShareSats: member.feeShareSats,
          fresh: member.fresh,
          previousCircleTxid: member.previousCircleTxid,
        };
      }),
      edges: edges.map((edge) => ({
        lineageId: edge.lineageId,
        fromCircleTxid: edge.fromCircleTxid,
        toCircleTxid: edge.toCircleTxid,
        viaTxid: edge.viaTxid,
        viaVout: edge.viaVout,
        canonical: edge.canonical,
      })),
      transaction: transaction
        ? {
            txid: transaction.txid,
            wtxid: transaction.wtxid,
            version: transaction.version,
            locktime: transaction.locktime,
            vsize: transaction.vsize,
            weight: transaction.weight,
            feeSats: transaction.feeSats,
            blockHeight: transaction.blockHeight,
            blockHash: transaction.blockHash,
            status: transaction.canonical ? 'confirmed' : 'orphaned',
          }
        : null,
      confirmations:
        circle.canonical && nodeHeight !== null
          ? Math.max(0, nodeHeight - circle.blockHeight + 1)
          : 0,
    };
  }

  async transaction(txidValue: string): Promise<Record<string, unknown>> {
    const txid = assertHex64(txidValue, 'txid');
    const transaction = await this.dataSource.manager.findOneBy(TransactionEntity, { txid });
    const mempool = await this.dataSource.manager.findOneBy(MempoolTransactionEntity, { txid });
    if (!transaction && !mempool) throw new NotFoundException('Transaction not found');
    const [inputs, outputs, circle, invalid, replacements, closures] = await Promise.all([
      queryRecords(
        this.dataSource,
        `SELECT vin, prev_txid AS prevTxid, prev_vout AS prevVout,
                prev_value_sats AS prevValueSats, prev_script_hash AS prevScriptHash,
                prev_address AS prevAddress, prev_block_height AS prevBlockHeight, sequence
         FROM wc_transaction_inputs WHERE txid = ? ORDER BY vin`,
        [txid],
      ),
      queryRecords(
        this.dataSource,
        `SELECT vout, value_sats AS valueSats, script_hex AS scriptHex,
                script_hash AS scriptHash, address, is_witc_marker AS isWitcMarker,
                shard_lineage_id AS shardLineageId, spent_by_txid AS spentByTxid
         FROM wc_transaction_outputs WHERE txid = ? ORDER BY vout`,
        [txid],
      ),
      this.dataSource.manager.findOneBy(CircleEntity, { circleTxid: txid }),
      queryRecords(this.dataSource, 'SELECT * FROM wc_invalid_events WHERE txid = ?', [txid]),
      queryRecords(
        this.dataSource,
        `SELECT old_txid AS oldTxid, new_txid AS newTxid, reason, observed_at AS observedAt
         FROM wc_mempool_replacements WHERE old_txid = ? OR new_txid = ?`,
        [txid, txid],
      ),
      this.dataSource.manager.find(LineageClosureEntity, {
        where: { spendingTxid: txid },
        order: { spendingVin: 'ASC', lineageId: 'ASC' },
      }),
    ]);
    return {
      transaction,
      inputs,
      outputs,
      circle,
      invalid: invalid[0] ?? null,
      closures,
      mempool,
      replacements,
    };
  }

  async lineages(query: LineagesQueryDto): Promise<Record<string, unknown>> {
    const cursor = decodeCursor<LineageCursor>(query.cursor);
    if (cursor && (!Number.isInteger(cursor.height) || !/^[0-9a-f]{64}$/.test(cursor.id))) {
      throw new BadRequestException('Invalid lineage cursor');
    }
    const parameters: unknown[] = [];
    let filters = '1 = 1';
    if (query.status) {
      filters += ' AND status = ?';
      parameters.push(query.status);
    }
    if (query.scriptHash) {
      filters += ' AND current_script_hash = ?';
      parameters.push(query.scriptHash.toLowerCase());
    }
    if (cursor) {
      filters += ' AND (last_height, lineage_id) < (?, ?)';
      parameters.push(cursor.height, cursor.id);
    }
    parameters.push(query.limit + 1);
    const rows = (await this.dataSource.query(
      `SELECT lineage_id AS lineageId, genesis_txid AS genesisTxid, genesis_vout AS genesisVout,
              current_txid AS currentTxid, current_vout AS currentVout,
              current_value_sats AS currentValueSats, current_script_hash AS currentScriptHash,
              current_address AS currentAddress, status, first_height AS firstHeight,
              last_height AS lastHeight, circle_count AS circleCount,
              last_circle_txid AS lastCircleTxid, closed_by_txid AS closedByTxid
       FROM wc_lineages WHERE ${filters}
       ORDER BY last_height DESC, lineage_id DESC LIMIT ?`,
      parameters,
    )) as Array<Record<string, unknown>>;
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items,
      limit: query.limit,
      nextCursor:
        hasMore && last
          ? encodeCursor({ height: Number(last.lastHeight), id: String(last.lineageId) })
          : null,
    };
  }

  async lineage(lineageIdValue: string): Promise<Record<string, unknown>> {
    const lineageId = assertHex64(lineageIdValue, 'lineageId');
    const lineage = await this.dataSource.manager.findOneBy(LineageEntity, { lineageId });
    if (!lineage) throw new NotFoundException('Lineage not found');
    const [currentShard, history] = await Promise.all([
      lineage.currentTxid === null || lineage.currentVout === null
        ? null
        : this.dataSource.manager.findOneBy(ShardEntity, {
            txid: lineage.currentTxid,
            vout: lineage.currentVout,
          }),
      this.lineageHistory(lineageId),
    ]);
    return { lineage, currentShard, ...history };
  }

  async lineageHistory(
    lineageIdValue: string,
    query?: LineageHistoryQueryDto,
  ): Promise<Record<string, unknown>> {
    const lineageId = assertHex64(lineageIdValue, 'lineageId');
    if (!query || (query.limit === undefined && query.cursor === undefined)) {
      const [circles, closures, shards] = await Promise.all([
        queryRecords(
          this.dataSource,
          `SELECT c.circle_txid AS txid, c.block_height AS blockHeight,
                  c.tx_position AS txPosition, c.context_hash AS contextHash,
                  c.participant_count AS participantCount, m.slot, m.fresh,
                  m.input_txid AS inputTxid, m.input_vout AS inputVout,
                  m.output_vout AS outputVout, m.fee_share_sats AS feeShareSats
           FROM wc_circle_members m JOIN wc_circles c ON c.circle_txid = m.circle_txid
           WHERE m.lineage_id = ? AND c.canonical = TRUE
           ORDER BY c.block_height, c.tx_position, c.circle_txid`,
          [lineageId],
        ),
        this.dataSource.manager.find(LineageClosureEntity, {
          where: { lineageId, canonical: true },
          order: { blockHeight: 'ASC' },
        }),
        this.dataSource.manager.find(ShardEntity, {
          where: { lineageId },
          order: { createdHeight: 'ASC' },
        }),
      ]);
      return { circles, closures, shards };
    }
    const limit = query.limit ?? 50;
    const cursor = decodePositionCursor(query.cursor, 'lineage history');
    const parameters: unknown[] = [lineageId];
    let cursorFilter = '';
    if (cursor) {
      cursorFilter = 'AND (c.block_height, c.tx_position, c.circle_txid) > (?, ?, ?)';
      parameters.push(cursor.height, cursor.position, cursor.txid);
    }
    parameters.push(limit + 1);
    const rows = await queryRecords(
      this.dataSource,
      `SELECT c.circle_txid AS txid, c.block_height AS blockHeight,
              c.tx_position AS txPosition, c.context_hash AS contextHash,
              c.participant_count AS participantCount, m.slot, m.fresh,
              m.input_txid AS inputTxid, m.input_vout AS inputVout,
              m.output_vout AS outputVout, m.fee_share_sats AS feeShareSats
       FROM wc_circle_members m JOIN wc_circles c ON c.circle_txid = m.circle_txid
       WHERE m.lineage_id = ? AND c.canonical = TRUE ${cursorFilter}
       ORDER BY c.block_height, c.tx_position, c.circle_txid LIMIT ?`,
      parameters,
    );
    const hasMore = rows.length > limit;
    const circles = rows.slice(0, limit);
    const txids = circles.map((circle) => String(circle.txid));
    const [closures, shards] = await Promise.all([
      this.dataSource.manager.find(LineageClosureEntity, {
        where: { lineageId, canonical: true },
        order: { blockHeight: 'ASC' },
      }),
      txids.length === 0
        ? Promise.resolve([])
        : queryRecords(
            this.dataSource,
            `SELECT txid, vout, lineage_id AS lineageId, value_sats AS valueSats,
                    script_hex AS scriptHex, script_hash AS scriptHash, address, status,
                    created_circle_txid AS createdCircleTxid, created_height AS createdHeight,
                    previous_txid AS previousTxid, previous_vout AS previousVout,
                    spent_by_txid AS spentByTxid, spent_by_vin AS spentByVin,
                    spent_height AS spentHeight
             FROM wc_shards WHERE lineage_id = ? AND created_circle_txid IN (${txids
               .map(() => '?')
               .join(', ')})
             ORDER BY created_height, txid, vout`,
            [lineageId, ...txids],
          ),
    ]);
    const last = circles.at(-1);
    return {
      circles,
      closures,
      shards,
      limit,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              height: Number(last.blockHeight),
              position: Number(last.txPosition),
              txid: String(last.txid),
            })
          : null,
    };
  }

  async shard(txidValue: string, vout: number): Promise<ShardEntity> {
    const txid = assertHex64(txidValue, 'txid');
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff_ffff) {
      throw new BadRequestException('vout is invalid');
    }
    const shard = await this.dataSource.manager.findOneBy(ShardEntity, { txid, vout });
    if (!shard) throw new NotFoundException('Witness shard not found');
    return shard;
  }

  async addressHoldings(
    address: string,
    query: CursorPaginationDto,
  ): Promise<Record<string, unknown>> {
    this.assertAddress(address);
    const cursor = decodeCursor<LineageCursor>(query.cursor);
    if (
      cursor &&
      (!Number.isInteger(cursor.height) || cursor.height < 0 || !/^[0-9a-f]{64}$/.test(cursor.id))
    ) {
      throw new BadRequestException('Invalid address holdings cursor');
    }
    const parameters: unknown[] = [address];
    let cursorFilter = '';
    if (cursor) {
      cursorFilter = 'AND (last_height, lineage_id) < (?, ?)';
      parameters.push(cursor.height, cursor.id);
    }
    parameters.push(query.limit + 1);
    const [rows, totals] = await Promise.all([
      queryRecords(
        this.dataSource,
        `SELECT lineage_id AS lineageId, genesis_txid AS genesisTxid,
              genesis_vout AS genesisVout, current_txid AS currentTxid,
              current_vout AS currentVout, current_value_sats AS currentValueSats,
              current_script_hash AS currentScriptHash, current_address AS currentAddress,
              status, first_height AS firstHeight, last_height AS lastHeight,
              circle_count AS circleCount, last_circle_txid AS lastCircleTxid,
              closed_by_txid AS closedByTxid
       FROM wc_lineages
       WHERE current_address = ? AND status = 'active' ${cursorFilter}
       ORDER BY last_height DESC, lineage_id DESC LIMIT ?`,
        parameters,
      ),
      queryRecords(
        this.dataSource,
        `SELECT COALESCE(SUM(current_value_sats), 0) AS totalValueSats
         FROM wc_lineages WHERE current_address = ? AND status = 'active'`,
        [address],
      ),
    ]);
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      address,
      items,
      pageValueSats: items.reduce(
        (sum, item) =>
          sum + BigInt(databaseDecimal(item.currentValueSats ?? 0, 'currentValueSats')),
        0n,
      ),
      totalValueSats: databaseDecimal(totals[0]?.totalValueSats ?? '0', 'totalValueSats'),
      limit: query.limit,
      nextCursor:
        hasMore && last
          ? encodeCursor({ height: Number(last.lastHeight), id: String(last.lineageId) })
          : null,
      truncated: hasMore,
    };
  }

  async addressActivity(
    address: string,
    query: CursorPaginationDto,
  ): Promise<Record<string, unknown>> {
    this.assertAddress(address);
    const cursor = decodeActivityCursor(query.cursor);
    const parameters: unknown[] = [address];
    let cursorFilter = '';
    if (cursor) {
      cursorFilter =
        'AND (activity.blockHeight, activity.txPosition, activity.txid, activity.activityKey) < (?, ?, ?, ?)';
      parameters.push(cursor.height, cursor.position, cursor.txid, cursor.key);
    }
    parameters.push(query.limit + 1);
    const rows = await queryRecords(
      this.dataSource,
      `SELECT activity.txid, activity.blockHeight, activity.txPosition, activity.contextHash,
              activity.lineageId, activity.slot, activity.feeShareSats, activity.kind,
              activity.spendingVin, activity.shardTxid, activity.shardVout, activity.reason,
              activity.activityKey
       FROM (
         SELECT c.circle_txid AS txid, c.block_height AS blockHeight,
                c.tx_position AS txPosition, c.context_hash AS contextHash,
                m.lineage_id AS lineageId, m.slot, m.fee_share_sats AS feeShareSats,
                'circle' AS kind, NULL AS spendingVin, NULL AS shardTxid,
                NULL AS shardVout, NULL AS reason, m.address,
                CONCAT('c:', m.lineage_id) AS activityKey
         FROM wc_circle_members m
         JOIN wc_circles c ON c.circle_txid = m.circle_txid
         WHERE c.canonical = TRUE
         UNION ALL
         SELECT closure.spending_txid AS txid, tx.block_height AS blockHeight,
                tx.position AS txPosition, NULL AS contextHash,
                closure.lineage_id AS lineageId, NULL AS slot, NULL AS feeShareSats,
                'closure' AS kind, closure.spending_vin AS spendingVin,
                closure.shard_txid AS shardTxid, closure.shard_vout AS shardVout,
                closure.reason, shard.address,
                CONCAT('x:', closure.lineage_id) AS activityKey
         FROM wc_lineage_closures closure
         JOIN wc_shards shard
           ON shard.txid = closure.shard_txid AND shard.vout = closure.shard_vout
         JOIN wc_transactions tx ON tx.txid = closure.spending_txid
         WHERE closure.canonical = TRUE
           AND tx.canonical = TRUE
           AND tx.confirmed = TRUE
       ) activity
       WHERE activity.address = ? ${cursorFilter}
       ORDER BY activity.blockHeight DESC, activity.txPosition DESC, activity.txid DESC,
                activity.activityKey DESC
       LIMIT ?`,
      parameters,
    );
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      address,
      items,
      limit: query.limit,
      nextCursor:
        hasMore && last
          ? encodeCursor({
              height: Number(last.blockHeight),
              position: Number(last.txPosition),
              txid: String(last.txid),
              key: String(last.activityKey),
            })
          : null,
      truncated: hasMore,
    };
  }

  async graph(query: GraphQueryDto): Promise<Record<string, unknown>> {
    const nodeLimit = Math.min(query.limit, 1_000);
    const frontierLimit = Math.min(nodeLimit, 500);
    const edgePageLimit = 2_000;
    const anchorTxid = query.txid ? assertHex64(query.txid, 'txid') : null;
    const lineageId = query.lineageId ? assertHex64(query.lineageId, 'lineageId') : null;
    if (anchorTxid && lineageId) {
      throw new BadRequestException('Graph accepts either txid or lineageId, not both');
    }
    let frontier = new Set<string>();
    let truncated = false;
    if (anchorTxid) frontier.add(anchorTxid);
    if (lineageId) {
      const members = await queryRecords(
        this.dataSource,
        `SELECT m.circle_txid AS circleTxid
         FROM wc_circle_members m
         JOIN wc_circles c ON c.circle_txid = m.circle_txid
         WHERE m.lineage_id = ? AND c.canonical = TRUE
         ORDER BY c.block_height DESC, c.tx_position DESC, c.circle_txid DESC
         LIMIT ?`,
        [lineageId, frontierLimit + 1],
      );
      truncated = members.length > frontierLimit;
      frontier = new Set(
        members.slice(0, frontierLimit).map(({ circleTxid }) => String(circleTxid)),
      );
    }
    if (frontier.size === 0 && !anchorTxid && !lineageId) {
      const latest = await this.dataSource.manager.find(CircleEntity, {
        where: { canonical: true },
        order: { blockHeight: 'DESC', txPosition: 'DESC', circleTxid: 'DESC' },
        take: nodeLimit + 1,
      });
      truncated ||= latest.length > nodeLimit;
      frontier = new Set(latest.slice(0, nodeLimit).map(({ circleTxid }) => circleTxid));
    }
    const nodes = new Set(frontier);
    const edgeMap = new Map<string, CircleEdgeEntity>();
    for (let depth = 0; depth < query.depth && frontier.size > 0; depth += 1) {
      const sortedFrontier = [...frontier].sort();
      truncated ||= sortedFrontier.length > frontierLimit;
      const ids = sortedFrontier.slice(0, frontierLimit);
      const edgePage = await this.dataSource.manager.find(CircleEdgeEntity, {
        where: [
          { fromCircleTxid: In(ids), canonical: true },
          { toCircleTxid: In(ids), canonical: true },
        ],
        order: {
          blockHeight: 'ASC',
          fromCircleTxid: 'ASC',
          toCircleTxid: 'ASC',
          lineageId: 'ASC',
          viaTxid: 'ASC',
          viaVout: 'ASC',
        },
        take: edgePageLimit + 1,
      });
      truncated ||= edgePage.length > edgePageLimit;
      const edges = edgePage.slice(0, edgePageLimit);
      const next = new Set<string>();
      for (const edge of edges) {
        const additions = [edge.fromCircleTxid, edge.toCircleTxid].filter((id) => !nodes.has(id));
        if (nodes.size + new Set(additions).size > nodeLimit) {
          truncated = true;
          continue;
        }
        edgeMap.set(
          `${edge.fromCircleTxid}:${edge.toCircleTxid}:${edge.lineageId}:${edge.viaTxid}:${edge.viaVout}`,
          edge,
        );
        for (const id of additions) {
          next.add(id);
          nodes.add(id);
        }
      }
      frontier = next;
    }
    if (frontier.size > 0) truncated = true;
    const circles =
      nodes.size === 0
        ? []
        : await this.dataSource.manager.find(CircleEntity, {
            where: {
              circleTxid: In([...nodes].sort().slice(0, nodeLimit)),
              canonical: true,
            },
            order: { blockHeight: 'ASC', txPosition: 'ASC', circleTxid: 'ASC' },
          });
    return { nodes: circles, edges: [...edgeMap.values()], truncated };
  }

  async mempool(query: MempoolQueryDto): Promise<Record<string, unknown>> {
    const builder = this.dataSource.manager
      .createQueryBuilder(MempoolTransactionEntity, 'mempool')
      .orderBy('mempool.lastSeenAt', 'DESC')
      .addOrderBy('mempool.txid', 'DESC')
      .take(query.limit + 1);
    if (query.status) builder.andWhere('mempool.status = :status', { status: query.status });
    if (query.protocolStatus) {
      builder.andWhere('mempool.protocolStatus = :protocolStatus', {
        protocolStatus: query.protocolStatus,
      });
    }
    if (query.cursor) {
      const cursor = decodeCursor<{ time: string; txid: string }>(query.cursor);
      if (!cursor || Number.isNaN(Date.parse(cursor.time)) || !/^[0-9a-f]{64}$/.test(cursor.txid)) {
        throw new BadRequestException('Invalid mempool cursor');
      }
      builder.andWhere(
        '(mempool.lastSeenAt < :time OR (mempool.lastSeenAt = :time AND mempool.txid < :txid))',
        {
          time: new Date(cursor.time),
          txid: cursor.txid,
        },
      );
    }
    const rows = await builder.getMany();
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items,
      limit: query.limit,
      nextCursor:
        hasMore && last
          ? encodeCursor({ time: last.lastSeenAt.toISOString(), txid: last.txid })
          : null,
    };
  }

  async mempoolTransaction(txidValue: string): Promise<Record<string, unknown>> {
    const txid = assertHex64(txidValue, 'txid');
    const transaction = await this.dataSource.manager.findOneBy(MempoolTransactionEntity, { txid });
    if (!transaction) throw new NotFoundException('Mempool transaction not found');
    const [inputs, conflicts, replacements] = await Promise.all([
      queryRecords(this.dataSource, 'SELECT * FROM wc_mempool_inputs WHERE txid = ? ORDER BY vin', [
        txid,
      ]),
      queryRecords(
        this.dataSource,
        `SELECT * FROM wc_mempool_conflicts
         WHERE first_txid = ? OR second_txid = ? ORDER BY observed_at`,
        [txid, txid],
      ),
      queryRecords(
        this.dataSource,
        `SELECT * FROM wc_mempool_replacements WHERE old_txid = ? OR new_txid = ?`,
        [txid, txid],
      ),
    ]);
    return { transaction, inputs, conflicts, replacements };
  }

  async invalidEvents(query: InvalidEventsQueryDto): Promise<Record<string, unknown>> {
    const cursor = decodeTimeCursor(query.cursor, 'invalid events');
    const parameters: unknown[] = [];
    let filters = '1 = 1';
    if (query.errorCode) {
      filters += ' AND error_code = ?';
      parameters.push(query.errorCode);
    }
    if (query.classification) {
      filters += ' AND classification = ?';
      parameters.push(query.classification);
    }
    if (cursor) {
      filters += ' AND (observed_at < ? OR (observed_at = ? AND txid < ?))';
      parameters.push(cursor.time, cursor.time, cursor.txid);
    }
    parameters.push(query.limit + 1);
    const rows = await queryRecords(
      this.dataSource,
      `SELECT txid, classification, error_code AS errorCode, detail, data_hex AS dataHex,
              block_hash AS blockHash, block_height AS blockHeight, mempool_only AS mempoolOnly,
              canonical, parser_version AS parserVersion, observed_at AS observedAt
       FROM wc_invalid_events WHERE ${filters}
       ORDER BY observed_at DESC, txid DESC LIMIT ?`,
      parameters,
    );
    const hasMore = rows.length > query.limit;
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    return {
      items,
      limit: query.limit,
      nextCursor:
        hasMore && last
          ? encodeCursor({ time: isoTimestamp(last.observedAt), txid: String(last.txid) })
          : null,
    };
  }

  async invalidEvent(txidValue: string): Promise<Record<string, unknown>> {
    const txid = assertHex64(txidValue, 'txid');
    const rows = (await this.dataSource.query('SELECT * FROM wc_invalid_events WHERE txid = ?', [
      txid,
    ])) as Array<Record<string, unknown>>;
    if (!rows[0]) throw new NotFoundException('Invalid event not found');
    return rows[0];
  }

  async search(query: SearchQueryDto): Promise<Record<string, unknown>> {
    const exactHex = /^[0-9a-fA-F]{64}$/.test(query.q);
    const cursor = decodeCursor<{ offset: number }>(query.cursor);
    if (cursor && (!Number.isInteger(cursor.offset) || cursor.offset < 0)) {
      throw new BadRequestException('Invalid search cursor');
    }
    const offset = cursor?.offset ?? 0;
    const rows = await queryRecords(
      this.dataSource,
      exactHex
        ? `SELECT document_type AS documentType, document_id AS documentId,
                  context_hash AS contextHash, title, sort_height AS sortHeight
           FROM wc_search_documents
           WHERE document_id = ? OR context_hash = ? OR body LIKE ?
           ORDER BY sort_height DESC, document_type, document_id LIMIT ? OFFSET ?`
        : `SELECT document_type AS documentType, document_id AS documentId,
                  context_hash AS contextHash, title, sort_height AS sortHeight,
                  MATCH(title, body) AGAINST (? IN NATURAL LANGUAGE MODE) AS score
           FROM wc_search_documents
           WHERE MATCH(title, body) AGAINST (? IN NATURAL LANGUAGE MODE)
           ORDER BY score DESC, sort_height DESC, document_type, document_id LIMIT ? OFFSET ?`,
      exactHex
        ? [
            query.q.toLowerCase(),
            query.q.toLowerCase(),
            `%${query.q.toLowerCase()}%`,
            query.limit + 1,
            offset,
          ]
        : [query.q, query.q, query.limit + 1, offset],
    );
    const hasMore = rows.length > query.limit;
    return {
      items: rows.slice(0, query.limit),
      limit: query.limit,
      nextCursor: hasMore ? encodeCursor({ offset: offset + query.limit }) : null,
    };
  }

  async trending(query: TrendingQueryDto): Promise<Record<string, unknown>> {
    const checkpoint = await this.store.getCheckpoint();
    const windowBlocks = { '24h': 144, '7d': 1_008, '30d': 4_320 }[query.window];
    const fromHeight = Math.max(
      this.store.startHeight,
      (checkpoint?.tipHeight ?? 0) - (windowBlocks - 1),
    );
    const items = await queryRecords(
      this.dataSource,
      `SELECT context_hash AS contextHash, COUNT(*) AS circles,
              SUM(participant_count) AS participantEvents,
              MAX(block_height) AS latestHeight
       FROM wc_circles WHERE canonical = TRUE AND block_height >= ?
       GROUP BY context_hash
       ORDER BY participantEvents DESC, latestHeight DESC, context_hash LIMIT ?`,
      [fromHeight, query.limit],
    );
    return {
      window: query.window,
      windowBlocks,
      fromHeight,
      throughHeight: checkpoint?.tipHeight ?? null,
      limit: query.limit,
      items,
    };
  }

  async stats(): Promise<Record<string, unknown>> {
    const stats = await this.dataSource.manager.find(ProtocolStatEntity, {
      order: { metricKey: 'ASC' },
    });
    const participantDistribution = await queryRecords(
      this.dataSource,
      `SELECT participant_count AS participantCount, COUNT(*) AS circles
       FROM wc_circles WHERE canonical = TRUE GROUP BY participant_count ORDER BY participant_count`,
    );
    return {
      values: Object.fromEntries(stats.map((item) => [item.metricKey, item.valueDecimal])),
      participantDistribution,
    };
  }

  async fees(query: FeesQueryDto): Promise<Record<string, unknown>> {
    const estimate = await this.rpc.estimateSmartFee(query.targetBlocks);
    const satPerVbyte = estimate.feerate
      ? Math.max(0.1, (estimate.feerate * 100_000_000) / 1_000)
      : null;
    const vsize = Math.ceil(61.5 + 100.5 * query.participants);
    const totalFeeSats = satPerVbyte === null ? null : Math.ceil(vsize * satPerVbyte);
    return {
      participants: query.participants,
      vsize,
      targetBlocks: query.targetBlocks,
      satPerVbyte,
      totalFeeSats,
      participantFeeShares:
        totalFeeSats === null
          ? null
          : Array.from(
              { length: query.participants },
              (_, slot) =>
                Math.floor(totalFeeSats / query.participants) +
                (slot < totalFeeSats % query.participants ? 1 : 0),
            ),
      estimateErrors: estimate.errors ?? [],
    };
  }

  async safetyOutpoints(outpoints: readonly SafetyOutpointDto[]): Promise<Record<string, unknown>> {
    if (outpoints.length < 1 || outpoints.length > 200) {
      throw new BadRequestException('Safety request must contain 1 to 200 outpoints');
    }
    const keys = outpoints.map(({ txid, vout }) => `${assertHex64(txid, 'txid')}:${vout}`);
    if (new Set(keys).size !== keys.length) {
      throw new BadRequestException('Safety request contains duplicate outpoints');
    }
    for (const outpoint of outpoints) {
      if (!Number.isInteger(outpoint.vout) || outpoint.vout < 0 || outpoint.vout > 0xffff_ffff) {
        throw new BadRequestException('vout is invalid');
      }
    }

    try {
      const runtimeBefore = this.syncStatus.snapshot();
      this.assertSafetyRuntime(runtimeBefore);
      const infoBefore = await this.rpc.getBlockchainInfo();
      this.assertSafetyCore(infoBefore);
      const mempoolBefore = await this.rpc.getRawMempoolSequence();
      const coreTxids = this.normalizedMempoolSnapshot(mempoolBefore);
      const tupleSql = outpoints.map(() => '(?, ?)').join(', ');
      const tupleParameters = outpoints.flatMap(({ txid, vout }) => [txid, vout]);
      const txidSql = outpoints.map(() => '?').join(', ');

      const database = await this.dataSource.transaction('REPEATABLE READ', async (manager) => {
        const checkpoint = await manager.findOneBy(CheckpointEntity, { id: 'canonical' });
        if (!checkpoint) throw new Error('Canonical checkpoint is unavailable');
        const [activeMempool, activeShards, pendingOutputs, pendingSpends] = (await Promise.all([
          manager.query(
            `SELECT txid, evaluated_tip_hash AS evaluatedTipHash
             FROM wc_mempool_transactions WHERE status = 'active' ORDER BY txid`,
          ),
          manager.query(
            `SELECT txid, vout, lineage_id AS lineageId, created_circle_txid AS circleTxid
             FROM wc_shards WHERE status = 'active' AND (txid, vout) IN (${tupleSql})`,
            tupleParameters,
          ),
          manager.query(
            `SELECT txid, protocol_status AS protocolStatus, projection_json AS projectionJson
             FROM wc_mempool_transactions
             WHERE status = 'active' AND txid IN (${txidSql})`,
            outpoints.map(({ txid }) => txid),
          ),
          manager.query(
            `SELECT i.prev_txid AS txid, i.prev_vout AS vout, i.txid AS spendingTxid,
                    m.protocol_status AS protocolStatus
             FROM wc_mempool_inputs i JOIN wc_mempool_transactions m ON m.txid = i.txid
             WHERE m.status = 'active' AND (i.prev_txid, i.prev_vout) IN (${tupleSql})
             ORDER BY i.prev_txid, i.prev_vout, i.txid`,
            tupleParameters,
          ),
        ])) as Array<Array<Record<string, unknown>>>;
        return {
          checkpoint,
          activeMempool: activeMempool ?? [],
          activeShards: activeShards ?? [],
          pendingOutputs: pendingOutputs ?? [],
          pendingSpends: pendingSpends ?? [],
        };
      });

      const mempoolAfter = await this.rpc.getRawMempoolSequence();
      const afterTxids = this.normalizedMempoolSnapshot(mempoolAfter);
      const infoAfter = await this.rpc.getBlockchainInfo();
      this.assertSafetyCore(infoAfter);
      const runtimeAfter = this.syncStatus.snapshot();
      this.assertSafetyRuntime(runtimeAfter);

      if (
        infoBefore.blocks !== infoAfter.blocks ||
        infoBefore.bestblockhash !== infoAfter.bestblockhash ||
        database.checkpoint.tipHeight !== infoBefore.blocks ||
        database.checkpoint.tipHash !== infoBefore.bestblockhash ||
        mempoolBefore.mempool_sequence !== mempoolAfter.mempool_sequence ||
        runtimeBefore.mempoolSequence !== mempoolBefore.mempool_sequence ||
        runtimeAfter.mempoolSequence !== mempoolAfter.mempool_sequence ||
        JSON.stringify(coreTxids) !== JSON.stringify(afterTxids)
      ) {
        throw new Error('Chain or mempool changed during the safety snapshot');
      }

      const localTxids = database.activeMempool.map((row) => String(row.txid)).sort();
      if (JSON.stringify(localTxids) !== JSON.stringify(coreTxids)) {
        throw new Error('Mempool projection is incomplete');
      }
      if (
        database.activeMempool.some((row) => row.evaluatedTipHash !== database.checkpoint.tipHash)
      ) {
        throw new Error('Mempool projection was evaluated against a different chain tip');
      }

      const shards = new Map(
        database.activeShards.map((row) => [`${String(row.txid)}:${Number(row.vout)}`, row]),
      );
      const pendingByTxid = new Map<string, { participantCount: number; lineages: string[] }>();
      for (const row of database.pendingOutputs) {
        if (row.protocolStatus !== 'valid') continue;
        const projection = this.parseProjection(row.projectionJson);
        const participantCount = Number(projection['participantCount']);
        const lineageValues = projection['lineages'];
        if (
          !Number.isInteger(participantCount) ||
          participantCount < 2 ||
          participantCount > 16 ||
          !Array.isArray(lineageValues) ||
          lineageValues.length !== participantCount
        ) {
          throw new Error('Valid mempool projection is malformed');
        }
        const lineages = lineageValues.map((value) => {
          if (
            typeof value !== 'object' ||
            value === null ||
            !/^[0-9a-f]{64}$/.test(String((value as Record<string, unknown>)['lineageId']))
          ) {
            throw new Error('Valid mempool lineage projection is malformed');
          }
          return String((value as Record<string, unknown>)['lineageId']);
        });
        pendingByTxid.set(String(row.txid), { participantCount, lineages });
      }
      const spenders = new Map<string, string[]>();
      for (const row of database.pendingSpends) {
        const key = `${String(row.txid)}:${Number(row.vout)}`;
        const values = spenders.get(key) ?? [];
        values.push(String(row.spendingTxid));
        spenders.set(key, values);
      }
      const coreSet = new Set(coreTxids);

      const items = outpoints.map(({ txid, vout }) => {
        const key = `${txid}:${vout}`;
        const shard = shards.get(key);
        const pending = pendingByTxid.get(txid);
        const spendingTxids = spenders.get(key) ?? [];
        let classification:
          'active-shard' | 'pending-successor' | 'pending-spend' | 'unconfirmed' | 'unclassified' =
          'unclassified';
        let lineageId: string | null = null;
        let circleTxid: string | null = null;
        if (shard) {
          lineageId = String(shard.lineageId);
          circleTxid = String(shard.circleTxid);
        } else if (pending && vout >= 1 && vout <= pending.participantCount) {
          lineageId = pending.lineages[vout - 1] ?? null;
          circleTxid = txid;
        }
        if (spendingTxids.length > 0) {
          classification = 'pending-spend';
        } else if (shard) {
          classification = 'active-shard';
        } else if (pending && vout >= 1 && vout <= pending.participantCount) {
          classification = 'pending-successor';
        } else if (coreSet.has(txid)) {
          classification = 'unconfirmed';
        }
        return {
          txid,
          vout,
          classification,
          protected: classification !== 'unclassified',
          lineageId,
          circleTxid,
          spendingTxids,
        };
      });

      return {
        complete: true,
        snapshot: {
          indexedHeight: database.checkpoint.tipHeight,
          indexedHash: database.checkpoint.tipHash,
          nodeHeight: infoAfter.blocks,
          nodeHash: infoAfter.bestblockhash,
          stateRoot: database.checkpoint.stateRoot,
          coreMempoolSequence: mempoolAfter.mempool_sequence,
          mempoolReconciledAt: runtimeAfter.lastMempoolAt,
        },
        items,
      };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        'A complete stable Witness safety snapshot is unavailable',
      );
    }
  }

  async validate(rawHex: string): Promise<Record<string, unknown>> {
    let transaction;
    try {
      transaction = await this.rpc.hydratePrevouts(decodeRawTransaction(rawHex));
    } catch (error) {
      throw new BadRequestException({
        code: 'RAW_TRANSACTION_INVALID',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const checkpoint = await this.dataSource.manager.findOneBy(CheckpointEntity, {
      id: 'canonical',
    });
    const evaluation = await this.engine.evaluate(transaction, {
      network: this.store.network,
      blockHeight: (checkpoint?.tipHeight ?? this.store.startHeight - 1) + 1,
      confirmed: false,
      lookup: new DatabaseStateLookup(this.dataSource.manager),
    });
    const policy = await this.rpc
      .testMempoolAccept(rawHex)
      .catch((error: unknown) => [
        { allowed: false, 'reject-reason': error instanceof Error ? error.message : String(error) },
      ]);
    return { txid: transaction.txid, evaluation, policy: policy[0] ?? null };
  }

  private assertAddress(address: string): void {
    if (address.length < 8 || address.length > 128 || !/^[A-Za-z0-9]+$/.test(address)) {
      throw new BadRequestException('Address is invalid');
    }
  }

  private assertSafetyRuntime(runtime: ReturnType<SyncStatusService['snapshot']>): void {
    const mempoolTime = runtime.lastMempoolAt ? Date.parse(runtime.lastMempoolAt) : Number.NaN;
    if (
      !runtime.initialized ||
      !runtime.ready ||
      !runtime.leader ||
      runtime.syncing ||
      runtime.mempoolSyncing ||
      runtime.lastError !== null ||
      runtime.lastMempoolError !== null ||
      runtime.mempoolSequence === null ||
      Number.isNaN(mempoolTime) ||
      mempoolTime - Date.now() > 30_000 ||
      Date.now() - mempoolTime > this.mempoolFreshMs
    ) {
      throw new ServiceUnavailableException('Witness index state is not ready for safety checks');
    }
  }

  private assertSafetyCore(info: Awaited<ReturnType<BitcoinRpcClient['getBlockchainInfo']>>): void {
    if (
      info.initialblockdownload ||
      info.chain !== CORE_CHAIN_BY_NETWORK[this.networkName] ||
      !Number.isInteger(info.blocks) ||
      !/^[0-9a-f]{64}$/.test(info.bestblockhash)
    ) {
      throw new ServiceUnavailableException('Bitcoin Core is not ready for Witness safety checks');
    }
  }

  private normalizedMempoolSnapshot(
    snapshot: Awaited<ReturnType<BitcoinRpcClient['getRawMempoolSequence']>>,
  ): string[] {
    if (
      !Number.isSafeInteger(snapshot.mempool_sequence) ||
      snapshot.mempool_sequence < 0 ||
      !Array.isArray(snapshot.txids) ||
      snapshot.txids.length > MAX_SAFETY_MEMPOOL_TRANSACTIONS ||
      snapshot.txids.some((txid) => !/^[0-9a-f]{64}$/.test(txid))
    ) {
      throw new ServiceUnavailableException('Bitcoin Core returned an invalid mempool snapshot');
    }
    const txids = [...snapshot.txids].sort();
    if (new Set(txids).size !== txids.length) {
      throw new ServiceUnavailableException('Bitcoin Core returned duplicate mempool txids');
    }
    return txids;
  }

  private parseProjection(value: unknown): Record<string, unknown> {
    const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Mempool projection is malformed');
    }
    return parsed as Record<string, unknown>;
  }
}
