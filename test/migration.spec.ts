import { QueryRunner } from 'typeorm';
import {
  InitWitnessV1_1796083200000,
  WITNESS_TABLES,
} from '../src/database/migrations/1796083200000-init-witness-v1';

describe('WITC database migration', () => {
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
});
