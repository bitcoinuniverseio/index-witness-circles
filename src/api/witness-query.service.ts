import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
  FeesQueryDto,
  GraphQueryDto,
  InvalidEventsQueryDto,
  LineagesQueryDto,
  MempoolQueryDto,
  SearchQueryDto,
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

  constructor(
    private readonly dataSource: DataSource,
    private readonly rpc: BitcoinRpcClient,
    private readonly store: IndexerStore,
    private readonly engine: WitnessStateEngine,
    private readonly syncStatus: SyncStatusService,
    configService: ConfigService<AppConfiguration, true>,
  ) {
    this.networkName = configService.get('network', { infer: true });
    this.settledConfirmations = configService.get('indexer', { infer: true }).confirmations;
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
    const [inputs, outputs, circle, invalid, replacements] = await Promise.all([
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
    ]);
    return {
      transaction,
      inputs,
      outputs,
      circle,
      invalid: invalid[0] ?? null,
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

  async lineageHistory(lineageIdValue: string): Promise<Record<string, unknown>> {
    const lineageId = assertHex64(lineageIdValue, 'lineageId');
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
         ORDER BY c.block_height, c.tx_position`,
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

  async shard(txidValue: string, vout: number): Promise<ShardEntity> {
    const txid = assertHex64(txidValue, 'txid');
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff_ffff) {
      throw new BadRequestException('vout is invalid');
    }
    const shard = await this.dataSource.manager.findOneBy(ShardEntity, { txid, vout });
    if (!shard) throw new NotFoundException('Witness shard not found');
    return shard;
  }

  async addressHoldings(address: string): Promise<Record<string, unknown>> {
    this.assertAddress(address);
    const items = await this.dataSource.manager.find(LineageEntity, {
      where: { currentAddress: address, status: 'active' },
      order: { lastHeight: 'DESC' },
      take: 500,
    });
    return {
      address,
      items,
      totalValueSats: items.reduce((sum, item) => sum + (item.currentValueSats ?? 0n), 0n),
      truncated: items.length === 500,
    };
  }

  async addressActivity(address: string): Promise<Record<string, unknown>> {
    this.assertAddress(address);
    const items = await queryRecords(
      this.dataSource,
      `SELECT c.circle_txid AS txid, c.block_height AS blockHeight, c.context_hash AS contextHash,
              m.lineage_id AS lineageId, m.slot, m.fee_share_sats AS feeShareSats, 'circle' AS kind
       FROM wc_circle_members m JOIN wc_circles c ON c.circle_txid = m.circle_txid
       WHERE m.address = ? AND c.canonical = TRUE
       ORDER BY c.block_height DESC, c.tx_position DESC LIMIT 500`,
      [address],
    );
    return { address, items, truncated: items.length === 500 };
  }

  async graph(query: GraphQueryDto): Promise<Record<string, unknown>> {
    const anchorTxid = query.txid ? assertHex64(query.txid, 'txid') : null;
    const lineageId = query.lineageId ? assertHex64(query.lineageId, 'lineageId') : null;
    let frontier = new Set<string>();
    if (anchorTxid) frontier.add(anchorTxid);
    if (lineageId) {
      const members = await this.dataSource.manager.findBy(CircleMemberEntity, { lineageId });
      frontier = new Set(members.map(({ circleTxid }) => circleTxid));
    }
    if (frontier.size === 0) {
      const latest = await this.dataSource.manager.find(CircleEntity, {
        where: { canonical: true },
        order: { blockHeight: 'DESC', txPosition: 'DESC' },
        take: Math.min(query.limit, 50),
      });
      frontier = new Set(latest.map(({ circleTxid }) => circleTxid));
    }
    const nodes = new Set(frontier);
    const edgeMap = new Map<string, CircleEdgeEntity>();
    for (
      let depth = 0;
      depth < query.depth && frontier.size > 0 && nodes.size < 1_000;
      depth += 1
    ) {
      const ids = [...frontier].slice(0, 500);
      const edges = await this.dataSource.manager.find(CircleEdgeEntity, {
        where: [
          { fromCircleTxid: In(ids), canonical: true },
          { toCircleTxid: In(ids), canonical: true },
        ],
        take: 2_000,
      });
      const next = new Set<string>();
      for (const edge of edges) {
        edgeMap.set(`${edge.fromCircleTxid}:${edge.toCircleTxid}:${edge.lineageId}`, edge);
        for (const id of [edge.fromCircleTxid, edge.toCircleTxid]) {
          if (!nodes.has(id)) next.add(id);
          nodes.add(id);
        }
      }
      frontier = next;
    }
    const circles =
      nodes.size === 0
        ? []
        : await this.dataSource.manager.findBy(CircleEntity, {
            circleTxid: In([...nodes].slice(0, 1_000)),
            canonical: true,
          });
    return { nodes: circles, edges: [...edgeMap.values()], truncated: nodes.size >= 1_000 };
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
    const builder = this.dataSource.manager
      .createQueryBuilder('wc_invalid_events', 'event')
      .select('*')
      .orderBy('event.observed_at', 'DESC')
      .take(query.limit + 1);
    if (query.errorCode) builder.andWhere('event.error_code = :code', { code: query.errorCode });
    if (query.classification) {
      builder.andWhere('event.classification = :classification', {
        classification: query.classification,
      });
    }
    const rows = await builder.getRawMany<Record<string, unknown>>();
    return { items: rows.slice(0, query.limit), limit: query.limit, nextCursor: null };
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
    const rows = await queryRecords(
      this.dataSource,
      exactHex
        ? `SELECT document_type AS documentType, document_id AS documentId,
                  context_hash AS contextHash, title, sort_height AS sortHeight
           FROM wc_search_documents
           WHERE document_id = ? OR context_hash = ? OR body LIKE ?
           ORDER BY sort_height DESC LIMIT ?`
        : `SELECT document_type AS documentType, document_id AS documentId,
                  context_hash AS contextHash, title, sort_height AS sortHeight,
                  MATCH(title, body) AGAINST (? IN NATURAL LANGUAGE MODE) AS score
           FROM wc_search_documents
           WHERE MATCH(title, body) AGAINST (? IN NATURAL LANGUAGE MODE)
           ORDER BY score DESC, sort_height DESC LIMIT ?`,
      exactHex
        ? [query.q.toLowerCase(), query.q.toLowerCase(), `%${query.q.toLowerCase()}%`, query.limit]
        : [query.q, query.q, query.limit],
    );
    return { items: rows, limit: query.limit, nextCursor: null };
  }

  async trending(): Promise<Record<string, unknown>> {
    const checkpoint = await this.store.getCheckpoint();
    const fromHeight = Math.max(this.store.startHeight, (checkpoint?.tipHeight ?? 0) - 143);
    const items = await queryRecords(
      this.dataSource,
      `SELECT context_hash AS contextHash, COUNT(*) AS circles,
              SUM(participant_count) AS participantEvents,
              MAX(block_height) AS latestHeight
       FROM wc_circles WHERE canonical = TRUE AND block_height >= ?
       GROUP BY context_hash
       ORDER BY participantEvents DESC, latestHeight DESC LIMIT 100`,
      [fromHeight],
    );
    return { fromHeight, throughHeight: checkpoint?.tipHeight ?? null, items };
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
}
