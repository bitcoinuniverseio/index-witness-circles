import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import { AppConfiguration } from '../config/configuration';

const LEASE_NAME = 'witness-canonical-ingester';
type Isolation = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

interface LeaseRow {
  ownerId?: string;
  fencingToken?: string | number;
  active?: string | number | boolean;
  remainingMs?: string | number;
}

interface MutationResult {
  affectedRows?: number;
}

export interface IndexerLeaseHandle {
  leaseName: string;
  ownerId: string;
  fencingToken: string;
  expiresAtMs: number;
}

export class IndexerLeaseUnavailableError extends Error {
  constructor() {
    super('This instance does not hold the canonical ingester lease');
    this.name = 'IndexerLeaseUnavailableError';
  }
}

export class IndexerLeaseLostError extends Error {
  constructor() {
    super('The canonical ingester lease was lost or fenced');
    this.name = 'IndexerLeaseLostError';
  }
}

@Injectable()
export class IndexerLeaseService implements OnModuleDestroy {
  private readonly logger = new Logger(IndexerLeaseService.name);
  private readonly ownerId: string;
  private readonly ttlMs: number;
  private readonly renewMs: number;
  private current: IndexerLeaseHandle | null = null;
  private timer: NodeJS.Timeout | null = null;
  private serial = Promise.resolve();
  private started = false;

  constructor(
    private readonly dataSource: DataSource,
    configService: ConfigService<AppConfiguration, true>,
    private readonly events: EventEmitter2,
  ) {
    const config = configService.get('indexer', { infer: true });
    this.ttlMs = config.leaseTtlMs;
    this.renewMs = config.leaseRenewMs;
    this.ownerId = (config.instanceId ?? `${hostname()}:${process.pid}:${randomUUID()}`).slice(
      0,
      128,
    );
  }

  async start(): Promise<IndexerLeaseHandle | null> {
    if (!this.started) {
      this.started = true;
      this.timer = setInterval(() => void this.heartbeat(), this.renewMs);
      this.timer.unref();
    }
    return this.acquireLeadership();
  }

  currentLeadership(): IndexerLeaseHandle | null {
    return this.current && Date.now() < this.current.expiresAtMs ? { ...this.current } : null;
  }

  isCurrent(handle: IndexerLeaseHandle): boolean {
    return (
      this.current?.ownerId === handle.ownerId &&
      this.current.fencingToken === handle.fencingToken &&
      Date.now() < this.current.expiresAtMs
    );
  }

  acquireLeadership(): Promise<IndexerLeaseHandle | null> {
    return this.serialize(async () => {
      if (this.current && Date.now() < this.current.expiresAtMs) return { ...this.current };
      this.current = null;
      const handle = await this.acquireFromDatabase();
      if (handle) this.setCurrent(handle);
      return handle ? { ...handle } : null;
    });
  }

  async requireLeadership(): Promise<IndexerLeaseHandle> {
    const handle = this.started ? await this.acquireLeadership() : await this.start();
    if (!handle) throw new IndexerLeaseUnavailableError();
    return handle;
  }

  async fencedTransaction<T>(
    handle: IndexerLeaseHandle,
    isolation: Isolation,
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    if (!this.isCurrent(handle)) throw new IndexerLeaseLostError();
    try {
      return await this.dataSource.transaction(isolation, async (manager) => {
        const rows = (await manager.query(
          `SELECT owner_id AS ownerId, CAST(fencing_token AS CHAR) AS fencingToken,
                  expires_at > UTC_TIMESTAMP(3) AS active
           FROM wc_indexer_leases WHERE lease_name = ? FOR UPDATE`,
          [handle.leaseName],
        )) as LeaseRow[];
        const row = rows[0];
        if (
          !row ||
          row.ownerId !== handle.ownerId ||
          String(row.fencingToken) !== handle.fencingToken ||
          Number(row.active) !== 1
        ) {
          throw new IndexerLeaseLostError();
        }
        return work(manager);
      });
    } catch (error) {
      if (error instanceof IndexerLeaseLostError) this.dropCurrent('fenced');
      throw error;
    }
  }

  assertLeadership(handle: IndexerLeaseHandle): Promise<void> {
    return this.fencedTransaction(handle, 'READ COMMITTED', async () => undefined);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const handle = this.current;
    this.current = null;
    if (!handle) return;
    await this.dataSource
      .query(
        `UPDATE wc_indexer_leases SET expires_at = UTC_TIMESTAMP(3)
         WHERE lease_name = ? AND owner_id = ? AND fencing_token = ?`,
        [handle.leaseName, handle.ownerId, handle.fencingToken],
      )
      .catch(() => undefined);
    this.events.emit('witness.leadership.lost', { reason: 'shutdown' });
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  private async acquireFromDatabase(): Promise<IndexerLeaseHandle | null> {
    return this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      await manager.query(
        `INSERT IGNORE INTO wc_indexer_leases
           (lease_name, owner_id, fencing_token, expires_at)
         VALUES (?, '', 0, '1970-01-01 00:00:00.000')`,
        [LEASE_NAME],
      );
      const result = (await manager.query(
        `UPDATE wc_indexer_leases
         SET owner_id = ?, fencing_token = fencing_token + 1,
             expires_at = TIMESTAMPADD(MICROSECOND, ?, UTC_TIMESTAMP(3))
         WHERE lease_name = ? AND expires_at <= UTC_TIMESTAMP(3)`,
        [this.ownerId, this.ttlMs * 1_000, LEASE_NAME],
      )) as MutationResult;
      if (result.affectedRows !== 1) return null;
      const rows = (await manager.query(
        `SELECT owner_id AS ownerId, CAST(fencing_token AS CHAR) AS fencingToken,
                GREATEST(0, TIMESTAMPDIFF(MICROSECOND, UTC_TIMESTAMP(3), expires_at) / 1000)
                  AS remainingMs
         FROM wc_indexer_leases WHERE lease_name = ?`,
        [LEASE_NAME],
      )) as LeaseRow[];
      return this.handle(rows[0]);
    });
  }

  private async heartbeat(): Promise<void> {
    await this.serialize(async () => {
      if (!this.started) return;
      if (!this.current) {
        const handle = await this.acquireFromDatabase();
        if (handle) this.setCurrent(handle);
        return;
      }
      try {
        const result = (await this.dataSource.query(
          `UPDATE wc_indexer_leases
           SET expires_at = TIMESTAMPADD(MICROSECOND, ?, UTC_TIMESTAMP(3))
           WHERE lease_name = ? AND owner_id = ? AND fencing_token = ?
             AND expires_at > UTC_TIMESTAMP(3)`,
          [this.ttlMs * 1_000, this.current.leaseName, this.ownerId, this.current.fencingToken],
        )) as MutationResult;
        if (result.affectedRows !== 1) return this.dropCurrent('renewal_rejected');
        this.current.expiresAtMs = Date.now() + this.ttlMs;
      } catch (error) {
        this.logger.error({
          event: 'lease_renewal_failed',
          error: error instanceof Error ? error.message : String(error),
        });
        this.dropCurrent('renewal_error');
      }
    });
  }

  private handle(row: LeaseRow | undefined): IndexerLeaseHandle | null {
    if (!row?.ownerId || row.fencingToken === undefined) return null;
    return {
      leaseName: LEASE_NAME,
      ownerId: row.ownerId,
      fencingToken: String(row.fencingToken),
      expiresAtMs: Date.now() + Math.max(0, Number(row.remainingMs ?? this.ttlMs)),
    };
  }

  private setCurrent(handle: IndexerLeaseHandle): void {
    this.current = handle;
    this.logger.log({ event: 'leadership_acquired', fencingToken: handle.fencingToken });
    this.events.emit('witness.leadership.acquired', { ...handle });
  }

  private dropCurrent(reason: string): void {
    if (!this.current) return;
    const fencingToken = this.current.fencingToken;
    this.current = null;
    this.logger.warn({ event: 'leadership_lost', fencingToken, reason });
    this.events.emit('witness.leadership.lost', { fencingToken, reason });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
