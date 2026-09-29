import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource } from 'typeorm';
import { AppConfiguration } from '../src/config/configuration';
import { IndexerLeaseService } from '../src/indexer/indexer-lease.service';

const OWNER = 'indexer-test-owner';

function leaseService() {
  const statements: string[] = [];
  let releaseTransaction: () => void = () => undefined;
  let holdTransaction = false;
  const manager = {
    query: jest.fn(async (sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.includes('FOR UPDATE')) {
        return [{ ownerId: OWNER, fencingToken: '7', active: 1 }];
      }
      if (sql.includes('SELECT owner_id')) {
        return [{ ownerId: OWNER, fencingToken: '7', remainingMs: 30_000 }];
      }
      return { affectedRows: 1 };
    }),
  };
  const dataSource = {
    transaction: jest.fn(
      async (_isolation: string, work: (m: typeof manager) => Promise<unknown>) => {
        const result = await work(manager);
        if (holdTransaction) await new Promise<void>((resolve) => (releaseTransaction = resolve));
        return result;
      },
    ),
    query: jest.fn(async (sql: string) => {
      statements.push(`HEARTBEAT ${sql.replace(/\s+/g, ' ').trim()}`);
      return { affectedRows: 1 };
    }),
  } as unknown as DataSource;
  const config = {
    get: jest.fn(() => ({ leaseTtlMs: 30_000, leaseRenewMs: 10_000, instanceId: OWNER })),
  } as unknown as ConfigService<AppConfiguration, true>;
  const service = new IndexerLeaseService(dataSource, config, {
    emit: jest.fn(),
  } as unknown as EventEmitter2);
  return {
    service,
    statements,
    hold: () => (holdTransaction = true),
    release: () => releaseTransaction(),
  };
}

describe('IndexerLeaseService renewal under long fenced transactions', () => {
  afterEach(() => jest.useRealTimers());

  it('renews the lease inside the fenced transaction that holds its row', async () => {
    const { service, statements } = leaseService();
    const handle = await service.requireLeadership();

    await service.fencedTransaction(handle, 'READ COMMITTED', async () => 'done');

    const lockAt = statements.findIndex((sql) => sql.includes('FOR UPDATE'));
    const renewAt = statements.findIndex(
      (sql) => sql.startsWith('UPDATE wc_indexer_leases') && sql.includes('fencing_token = ?'),
    );
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(renewAt).toBeGreaterThan(lockAt);
    expect(service.currentLeadership()).not.toBeNull();
    await service.stop();
  });

  it('does not queue a heartbeat behind its own in-flight fenced transaction', async () => {
    jest.useFakeTimers();
    const { service, statements, hold, release } = leaseService();
    const handle = await service.requireLeadership();
    hold();
    const pending = service.fencedTransaction(handle, 'SERIALIZABLE', async () => 'block');
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(statements.some((sql) => sql.startsWith('HEARTBEAT UPDATE'))).toBe(false);
    expect(service.currentLeadership()).not.toBeNull();

    release();
    await pending;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(statements.some((sql) => sql.startsWith('HEARTBEAT UPDATE'))).toBe(true);
    await service.stop();
  });
});
