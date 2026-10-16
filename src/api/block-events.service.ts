import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { AppConfiguration } from '../config/configuration';
import { SyncStatusService } from '../indexer/sync-status.service';

export const BLOCK_EVENTS_SCHEMA_VERSION = 'universe-block-events-v1';
export const BLOCK_EVENTS_PROTOCOL_ID = 'witness_circles';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const CURSOR_PATTERN =
  /^v1:(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9}):([0-9a-f]{64}):(0|[1-9][0-9]{0,2})$/;

interface CheckpointRow {
  tip_height: number | string;
  tip_hash: string | null;
}

interface MemberRow {
  circle_txid: string;
  tx_position: number | string;
  slot: number | string;
  lineage_id: string;
  input_txid: string;
  input_vout: number | string;
  output_vout: number | string;
  address: string | null;
  fresh: number | string | boolean;
}

interface CursorPosition {
  txPosition: number;
  txid: string;
  slot: number;
}

export interface IndexerCheckpoint {
  height: string;
  hash: string;
}

function parseHeight(raw: string): number {
  if (!/^[0-9]{1,10}$/.test(raw)) throw new BadRequestException('Invalid block height');
  return Number(raw);
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^[0-9]{1,3}$/.test(raw)) throw new BadRequestException('Invalid limit');
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_LIMIT) throw new BadRequestException('Invalid limit');
  return limit;
}

function encodeCursor(height: number, row: MemberRow): string {
  const value = `v1:${height}:${Number(row.tx_position)}:${row.circle_txid}:${Number(row.slot)}`;
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined, height: number): CursorPosition | null {
  if (raw === undefined) return null;
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const match = CURSOR_PATTERN.exec(decoded);
  // Re-encoding must reproduce the input exactly, so only cursors this route issued pass.
  if (!match || Buffer.from(decoded, 'utf8').toString('base64url') !== raw) {
    throw new BadRequestException('Invalid cursor');
  }
  if (Number(match[1]) !== height) throw new BadRequestException('Cursor is for another height');
  return { txPosition: Number(match[2]), txid: match[3]!, slot: Number(match[4]) };
}

function isTrue(value: number | string | boolean): boolean {
  return value === true || Number(value) === 1;
}

@Injectable()
export class BlockEventsService {
  private readonly networkName: AppConfiguration['network'];

  constructor(
    private readonly dataSource: DataSource,
    private readonly syncStatus: SyncStatusService,
    configService: ConfigService<AppConfiguration, true>,
  ) {
    this.networkName = configService.get('network', { infer: true });
  }

  async checkpoint(): Promise<Record<string, unknown>> {
    const checkpoint = await this.readCheckpoint(this.dataSource.manager);
    return { chain: 'bitcoin', network: this.networkName, ...checkpoint };
  }

  async blockEvents(
    rawHeight: string,
    rawLimit: string | undefined,
    rawCursor: string | undefined,
  ): Promise<Record<string, unknown>> {
    const height = parseHeight(rawHeight);
    const limit = parseLimit(rawLimit);
    const cursor = decodeCursor(rawCursor, height);
    if (!this.syncStatus.snapshot().ready) {
      throw new ServiceUnavailableException('Indexer is not ready');
    }

    // One consistent read snapshot so a concurrent reorg cannot mix checkpoint and rows.
    return this.dataSource.transaction('REPEATABLE READ', async (manager) => {
      const checkpoint = await this.readCheckpoint(manager);
      const envelope = {
        schemaVersion: BLOCK_EVENTS_SCHEMA_VERSION,
        chain: 'bitcoin',
        network: this.networkName,
        protocols: [BLOCK_EVENTS_PROTOCOL_ID],
        height: String(height),
        checkpoint,
      };
      if (height > Number(checkpoint.height)) {
        return {
          ...envelope,
          blockHash: null,
          indexed: false,
          events: [],
          nextCursor: null,
          complete: false,
        };
      }

      const blocks = await manager.query<Array<{ hash: string }>>(
        'SELECT hash FROM wc_blocks WHERE height = ? AND canonical = TRUE LIMIT 1',
        [height],
      );
      const blockHash = blocks[0]?.hash.toLowerCase() ?? null;

      // Only valid Circles are written to wc_circles; reorgs flip them to orphaned/non-canonical.
      const clauses = [
        "c.status = 'confirmed'",
        'c.canonical = TRUE',
        'c.block_height = ?',
        'm.block_height = c.block_height',
      ];
      const parameters: unknown[] = [height];
      if (blockHash !== null) {
        clauses.push('c.block_hash = ?');
        parameters.push(blockHash);
      }
      if (cursor) {
        clauses.push('(c.tx_position, c.circle_txid, m.slot) > (?, ?, ?)');
        parameters.push(cursor.txPosition, cursor.txid, cursor.slot);
      }
      parameters.push(limit + 1);
      const rows = await manager.query<MemberRow[]>(
        `SELECT c.circle_txid, c.tx_position, m.slot, m.lineage_id, m.input_txid, m.input_vout,
                m.output_vout, m.address, m.fresh
         FROM wc_circles c
         JOIN wc_circle_members m ON m.circle_txid = c.circle_txid
         WHERE ${clauses.join(' AND ')}
         ORDER BY c.tx_position ASC, c.circle_txid ASC, m.slot ASC
         LIMIT ?`,
        parameters,
      );
      const page = rows.slice(0, limit);
      const hasMore = rows.length > limit;
      return {
        ...envelope,
        blockHash,
        indexed: true,
        events: page.map((row) => this.project(row)),
        nextCursor: hasMore ? encodeCursor(height, page[page.length - 1]!) : null,
        complete: !hasMore,
      };
    });
  }

  /** One event per Circle member slot: a fresh lineage starts, an existing one advances. */
  private project(row: MemberRow): Record<string, unknown> {
    const txid = row.circle_txid.toLowerCase();
    const slot = Number(row.slot);
    return {
      eventId: `${BLOCK_EVENTS_PROTOCOL_ID}:${txid}:${slot}`,
      protocolId: BLOCK_EVENTS_PROTOCOL_ID,
      txid,
      txIndex: Number(row.tx_position),
      operation: isTrue(row.fresh) ? 'register' : 'update',
      assetId: row.lineage_id.toLowerCase(),
      ticker: null,
      displayName: null,
      assetKind: 'protocol-event',
      amountAtomic: null,
      decimals: null,
      fromAddress: null,
      toAddress: row.address,
      inputOutpoint: `${row.input_txid.toLowerCase()}:${Number(row.input_vout)}`,
      outputOutpoint: `${txid}:${Number(row.output_vout)}`,
      inscriptionId: null,
    };
  }

  private async readCheckpoint(manager: EntityManager): Promise<IndexerCheckpoint> {
    const rows = await manager.query<CheckpointRow[]>(
      "SELECT tip_height, tip_hash FROM wc_checkpoints WHERE id = 'canonical'",
    );
    const row = rows[0];
    if (!row || row.tip_hash === null || Number(row.tip_height) < 0) {
      throw new ServiceUnavailableException('Indexer checkpoint is not available');
    }
    return { height: String(Number(row.tip_height)), hash: row.tip_hash.toLowerCase() };
  }
}
