import { DataSourceOptions } from 'typeorm';
import { AppConfiguration } from '../config/configuration';
import { ENTITIES } from './entities';
import { InitWitnessV1_1796083200000 } from './migrations/1796083200000-init-witness-v1';

export function databaseOptions(config: Pick<AppConfiguration, 'database'>): DataSourceOptions {
  const shared = {
    port: config.database.port,
    database: config.database.database,
    username: config.database.username,
    password: config.database.password,
  };
  return {
    type: 'mysql',
    ...(config.database.readHosts.length > 0
      ? {
          replication: {
            master: { host: config.database.host, ...shared },
            slaves: config.database.readHosts.map((host) => ({ host, ...shared })),
          },
        }
      : { host: config.database.host, ...shared }),
    ssl: config.database.ssl ? { rejectUnauthorized: true } : undefined,
    charset: 'utf8mb4_bin',
    timezone: 'Z',
    entities: ENTITIES,
    migrations: [InitWitnessV1_1796083200000],
    migrationsTableName: 'typeorm_migrations',
    synchronize: false,
    logging: false,
    extra: { connectionLimit: config.database.poolSize },
  };
}
