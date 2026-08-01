import { DataSource, EntityManager } from 'typeorm';

export async function withMasterRead<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const runner = dataSource.createQueryRunner('master');
  await runner.connect();
  try {
    return await work(runner.manager);
  } finally {
    await runner.release();
  }
}
