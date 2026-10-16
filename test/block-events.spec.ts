import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { BlockEventsService } from '../src/api/block-events.service';
import { ExplorerController } from '../src/api/explorer.controller';
import { AppConfiguration } from '../src/config/configuration';
import { SyncStatusService } from '../src/indexer/sync-status.service';

const HEIGHT = 840000;
const BLOCK_HASH = 'ab'.repeat(32);
const ORPHAN_HASH = 'ee'.repeat(32);
const TIP_HASH = 'cd'.repeat(32);

function hex(n: number): string {
  return n.toString(16).padStart(64, '0');
}

interface StoredCircle {
  circle_txid: string;
  status: string;
  canonical: boolean;
  block_hash: string;
  block_height: number;
  tx_position: number;
  members: Array<{ slot: number; fresh: number; address: string | null }>;
}

/**
 * In-memory evaluator for the SQL the service issues, so the canonical/status
 * filters, block hash binding, keyset cursor, and LIMIT are all exercised.
 */
function fakeDatabase(circles: StoredCircle[], tipHeight = 840100) {
  const query = jest.fn(async (sql: string, parameters: unknown[] = []) => {
    if (sql.includes('FROM wc_checkpoints')) return [{ tip_height: tipHeight, tip_hash: TIP_HASH }];
    if (sql.includes('FROM wc_blocks')) {
      return parameters[0] === HEIGHT ? [{ hash: BLOCK_HASH }] : [];
    }
    if (sql.includes('FROM wc_circles')) {
      expect(sql).toContain("c.status = 'confirmed'");
      expect(sql).toContain('c.canonical = TRUE');
      const params = [...parameters];
      const height = params.shift();
      const hash = sql.includes('c.block_hash = ?') ? params.shift() : undefined;
      const cursor = sql.includes('> (?, ?, ?)')
        ? {
            position: params.shift() as number,
            txid: params.shift() as string,
            slot: params.shift() as number,
          }
        : null;
      const limit = params.shift() as number;
      return circles
        .filter((c) => c.status === 'confirmed' && c.canonical && c.block_height === height)
        .filter((c) => hash === undefined || c.block_hash === hash)
        .flatMap((c) =>
          c.members.map((m, index) => ({
            circle_txid: c.circle_txid,
            tx_position: c.tx_position,
            slot: m.slot,
            lineage_id: hex(1000 + c.tx_position * 20 + m.slot),
            input_txid: hex(5000 + index),
            input_vout: index,
            output_vout: m.slot + 1,
            address: m.address,
            fresh: m.fresh,
          })),
        )
        .filter(
          (row) =>
            !cursor ||
            row.tx_position > cursor.position ||
            (row.tx_position === cursor.position &&
              (row.circle_txid > cursor.txid ||
                (row.circle_txid === cursor.txid && row.slot > cursor.slot))),
        )
        .sort(
          (a, b) =>
            a.tx_position - b.tx_position ||
            a.circle_txid.localeCompare(b.circle_txid) ||
            a.slot - b.slot,
        )
        .slice(0, limit);
    }
    throw new Error(`unexpected SQL ${sql}`);
  });
  const manager = { query };
  const dataSource = {
    manager,
    transaction: jest.fn(async (_isolation: string, run: (m: typeof manager) => unknown) =>
      run(manager),
    ),
  } as unknown as DataSource;
  return { dataSource, query };
}

const config = {
  get: jest.fn().mockReturnValue('mainnet'),
} as unknown as ConfigService<AppConfiguration, true>;

function syncStatus(ready: boolean): SyncStatusService {
  return { snapshot: () => ({ ready }) } as unknown as SyncStatusService;
}

function circle(overrides: Partial<StoredCircle>): StoredCircle {
  return {
    circle_txid: hex(1),
    status: 'confirmed',
    canonical: true,
    block_hash: BLOCK_HASH,
    block_height: HEIGHT,
    tx_position: 1,
    members: [
      { slot: 0, fresh: 1, address: 'bc1pmemberzero' },
      { slot: 1, fresh: 0, address: null },
    ],
    ...overrides,
  };
}

const stored = [
  circle({ circle_txid: hex(2), tx_position: 7 }),
  circle({ circle_txid: hex(1), tx_position: 3 }),
  circle({ circle_txid: hex(9), tx_position: 4, status: 'orphaned', canonical: false }),
  circle({ circle_txid: hex(8), tx_position: 5, block_hash: ORPHAN_HASH }),
  circle({ circle_txid: hex(7), tx_position: 2, block_height: HEIGHT + 1 }),
];

function service(ready = true, tipHeight = 840100) {
  const { dataSource, query } = fakeDatabase(stored, tipHeight);
  return { svc: new BlockEventsService(dataSource, syncStatus(ready), config), query };
}

type Event = Record<string, unknown>;

describe('BlockEventsService (universe-block-events-v1)', () => {
  it('emits one event per member of each confirmed canonical Circle', async () => {
    const result = await service().svc.blockEvents(String(HEIGHT), undefined, undefined);
    expect(result).toMatchObject({
      schemaVersion: 'universe-block-events-v1',
      chain: 'bitcoin',
      network: 'mainnet',
      protocols: ['witness_circles'],
      height: '840000',
      blockHash: BLOCK_HASH,
      indexed: true,
      checkpoint: { height: '840100', hash: TIP_HASH },
      nextCursor: null,
      complete: true,
    });
    const events = result.events as Event[];
    expect(events.map((e) => e.eventId)).toEqual([
      `witness_circles:${hex(1)}:0`,
      `witness_circles:${hex(1)}:1`,
      `witness_circles:${hex(2)}:0`,
      `witness_circles:${hex(2)}:1`,
    ]);
    expect(events[0]).toEqual({
      eventId: `witness_circles:${hex(1)}:0`,
      protocolId: 'witness_circles',
      txid: hex(1),
      txIndex: 3,
      operation: 'register',
      assetId: hex(1000 + 60),
      ticker: null,
      displayName: null,
      assetKind: 'protocol-event',
      amountAtomic: null,
      decimals: null,
      fromAddress: null,
      toAddress: 'bc1pmemberzero',
      inputOutpoint: `${hex(5000)}:0`,
      outputOutpoint: `${hex(1)}:1`,
      inscriptionId: null,
    });
    expect(events[1]).toMatchObject({ operation: 'update', toAddress: null });
  });

  it('pages with an opaque stable cursor and LIMIT+1 lookahead', async () => {
    const { svc } = service();
    const first = await svc.blockEvents(String(HEIGHT), '3', undefined);
    expect((first.events as Event[]).map((e) => e.eventId)).toHaveLength(3);
    expect(first.complete).toBe(false);
    expect(typeof first.nextCursor).toBe('string');
    expect((await svc.blockEvents(String(HEIGHT), '3', undefined)).nextCursor).toBe(
      first.nextCursor,
    );

    const second = await svc.blockEvents(String(HEIGHT), '3', first.nextCursor as string);
    expect((second.events as Event[]).map((e) => e.eventId)).toEqual([
      `witness_circles:${hex(2)}:1`,
    ]);
    expect(second.nextCursor).toBeNull();
    expect(second.complete).toBe(true);
  });

  it('excludes orphaned, non-canonical, and other-branch Circles', async () => {
    const result = await service().svc.blockEvents(String(HEIGHT), '500', undefined);
    const txids = (result.events as Event[]).map((e) => e.txid);
    expect(txids).not.toContain(hex(9));
    expect(txids).not.toContain(hex(8));
    expect(txids).not.toContain(hex(7));
  });

  it('reports indexed:false above the checkpoint without reading Circles', async () => {
    const { svc, query } = service(true, HEIGHT - 1);
    await expect(svc.blockEvents(String(HEIGHT), undefined, undefined)).resolves.toMatchObject({
      blockHash: null,
      indexed: false,
      events: [],
      nextCursor: null,
      complete: false,
      checkpoint: { height: String(HEIGHT - 1), hash: TIP_HASH },
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('FROM wc_circles'))).toBe(false);
  });

  it('returns 503 when the indexer is not ready', async () => {
    await expect(
      service(false).svc.blockEvents(String(HEIGHT), undefined, undefined),
    ).rejects.toMatchObject({ status: 503 });
  });

  it('serves the checkpoint from the indexer database', async () => {
    await expect(service().svc.checkpoint()).resolves.toEqual({
      chain: 'bitcoin',
      network: 'mainnet',
      height: '840100',
      hash: TIP_HASH,
    });
  });
});

describe('ExplorerController routes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ExplorerController],
      providers: [{ provide: BlockEventsService, useValue: service().svc }],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => app.close());

  it('serves the contract routes at the server root', async () => {
    const response = await request(app.getHttpServer()).get('/v1/explorer/blocks/840000/events');
    expect(response.status).toBe(200);
    expect(response.body.events).toHaveLength(4);
    expect((await request(app.getHttpServer()).get('/v1/checkpoint')).status).toBe(200);
  });

  it.each([
    '/v1/explorer/blocks/abc/events',
    '/v1/explorer/blocks/-1/events',
    '/v1/explorer/blocks/12345678901/events',
    '/v1/explorer/blocks/840000/events?limit=0',
    '/v1/explorer/blocks/840000/events?limit=501',
    '/v1/explorer/blocks/840000/events?limit=abc',
    '/v1/explorer/blocks/840000/events?cursor=not-a-cursor',
    `/v1/explorer/blocks/840000/events?cursor=${Buffer.from(`v1:840001:1:${hex(1)}:0`).toString('base64url')}`,
  ])('rejects %s with 400', async (path) => {
    expect((await request(app.getHttpServer()).get(path)).status).toBe(400);
  });
});
