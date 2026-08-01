import { QueryRunner } from 'typeorm';
import { databaseOptions } from '../src/database/options';
import {
  InitWitnessV1_1796083200000,
  WITNESS_TABLES,
} from '../src/database/migrations/1796083200000-init-witness-v1';
import { HardenWitnessState1796083201000 } from '../src/database/migrations/1796083201000-harden-witness-state';

describe('WITC database migration', () => {
  it('registers the canonical reset migration after the initial schema', () => {
    const options = databaseOptions({
      database: {
        host: '127.0.0.1',
        readHosts: [],
        port: 3306,
        database: 'witness_test',
        username: 'witness',
        password: '',
        poolSize: 2,
        ssl: false,
      },
    });
    expect(options.migrations).toEqual([
      InitWitnessV1_1796083200000,
      HardenWitnessState1796083201000,
    ]);
  });

  it('creates every normalized table and critical invariant', async () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn((sql: string) => {
        statements.push(sql);
        return Promise.resolve([]);
      }),
    } as unknown as QueryRunner;
    await new InitWitnessV1_1796083200000().up(runner);
    const sql = statements.join('\n');
    for (const table of WITNESS_TABLES) expect(sql).toContain(`CREATE TABLE ${table}`);
    expect(sql).toContain('participant_count BETWEEN 2 AND 16');
    expect(sql).toContain('value_sats >= 1000');
    expect(sql).toContain('FULLTEXT KEY idx_wc_search_fulltext');
    expect(sql).toContain('fork_height INT NOT NULL');
    expect(sql).toContain('trusted_for_protocol = FALSE');
    expect(sql).not.toMatch(/transfer|marketplace|refuel/i);
  });

  it('drops only the WITC-owned table list in reverse order', async () => {
    const statements: string[] = [];
    const runner = {
      query: jest.fn((sql: string) => {
        statements.push(sql);
        return Promise.resolve([]);
      }),
    } as unknown as QueryRunner;
    await new InitWitnessV1_1796083200000().down(runner);
    const drops = statements.filter((statement) => statement.startsWith('DROP TABLE'));
    expect(drops).toHaveLength(WITNESS_TABLES.length);
    expect(drops[0]).toContain(WITNESS_TABLES.at(-1));
    expect(drops.at(-1)).toContain(WITNESS_TABLES[0]);
  });

  it('adds mempool tips and forces a canonical state-root replay', async () => {
    const statements: string[] = [];
    const parameters: unknown[][] = [];
    const runner = {
      hasColumn: jest.fn().mockResolvedValue(false),
      query: jest.fn((sql: string, values: unknown[] = []) => {
        statements.push(sql);
        parameters.push(values);
        return Promise.resolve([]);
      }),
    } as unknown as QueryRunner;
    const migration = new HardenWitnessState1796083201000();
    await migration.up(runner);
    const sql = statements.join('\n');
    expect(sql).toContain('evaluated_tip_height');
    expect(sql).toContain('evaluated_tip_hash');
    expect(sql).toContain('ALTER TABLE wc_reorgs MODIFY COLUMN fork_height INT NOT NULL');
    expect(sql).toContain('SET s.previous_txid = m.input_txid');
    expect(sql).toContain('DELETE FROM wc_block_undo');
    expect(sql).toContain('DELETE FROM wc_circles');
    expect(sql).toContain('DELETE FROM wc_blocks');
    expect(sql).toContain("VALUES ('0.2.0', NULL, 'witc-indexer-v2')");
    expect(sql).toContain('ON DUPLICATE KEY UPDATE schema_version');
    expect(sql.indexOf('DELETE FROM wc_circle_edges')).toBeLessThan(
      sql.indexOf('DELETE FROM wc_circles'),
    );
    expect(sql.indexOf('DELETE FROM wc_transactions')).toBeLessThan(
      sql.indexOf('DELETE FROM wc_blocks'),
    );
    expect(sql).toContain('tip_height = CAST(start_height AS SIGNED) - 1');
    expect(sql).toContain("status = 'reindexing'");
    expect(parameters).toContainEqual([
      '90e749b7720fac379610d979e29998c7d650150548622f0a47d9d3e181f1be52',
    ]);
  });

  it('resumes safely after either additive migration DDL statement already committed', async () => {
    const statements: string[] = [];
    const runner = {
      hasColumn: jest.fn(
        async (_table: string, column: string) => column === 'evaluated_tip_height',
      ),
      query: jest.fn((sql: string) => {
        statements.push(sql);
        return Promise.resolve([]);
      }),
    } as unknown as QueryRunner;

    await new HardenWitnessState1796083201000().up(runner);

    expect(statements.join('\n')).not.toContain('ADD COLUMN evaluated_tip_height');
    expect(statements.join('\n')).toContain('ADD COLUMN evaluated_tip_hash');
  });

  it('refuses a lossy partial migration revert', async () => {
    await expect(new HardenWitnessState1796083201000().down()).rejects.toThrow(/irreversible/);
  });
});
