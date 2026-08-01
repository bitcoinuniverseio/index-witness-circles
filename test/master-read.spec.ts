import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { withMasterRead } from '../src/database/master-read';

describe('withMasterRead', () => {
  it('pins correctness-sensitive reads to the primary and always releases the connection', async () => {
    const manager = {} as EntityManager;
    const runner = {
      manager,
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    } as unknown as QueryRunner;
    const dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(runner),
    } as unknown as DataSource;

    await expect(withMasterRead(dataSource, async (value) => value)).resolves.toBe(manager);
    expect(dataSource.createQueryRunner).toHaveBeenCalledWith('master');
    expect(runner.connect).toHaveBeenCalledTimes(1);
    expect(runner.release).toHaveBeenCalledTimes(1);
  });
});
