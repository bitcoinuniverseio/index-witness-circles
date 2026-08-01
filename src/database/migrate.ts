import 'reflect-metadata';
import { DataSource, Migration } from 'typeorm';
import AppDataSource from './data-source';

export async function runMigrationsOnce(dataSource: DataSource): Promise<Migration[]> {
  if (!dataSource.isInitialized) await dataSource.initialize();
  const database = String(dataSource.options.database ?? 'witness_circles');
  const lockName = `witness:migrations:${database}`.slice(0, 64);
  const runner = dataSource.createQueryRunner('master');
  await runner.connect();
  let acquired = false;
  try {
    const rows = (await runner.query('SELECT GET_LOCK(?, 30) AS acquired', [lockName])) as Array<{
      acquired?: string | number | null;
    }>;
    acquired = Number(rows[0]?.acquired) === 1;
    if (!acquired) throw new Error(`Could not acquire migration lock ${lockName}`);
    return await dataSource.runMigrations({ transaction: 'all' });
  } finally {
    if (acquired) await runner.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined);
    await runner.release();
  }
}

async function main(): Promise<void> {
  try {
    const migrations = await runMigrationsOnce(AppDataSource);
    process.stdout.write(
      `Applied ${migrations.length} migration(s): ${migrations.map(({ name }) => name).join(', ') || 'none'}\n`,
    );
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
