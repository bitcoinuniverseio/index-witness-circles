import { Injectable, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class DatabaseMigrationGuard implements OnModuleInit {
  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    const tableName = this.dataSource.options.migrationsTableName ?? 'migrations';
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) throw new Error('Invalid migration table name');
    const rows = (await this.dataSource.query(
      `SELECT COUNT(*) AS tableCount FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ?`,
      [tableName],
    )) as Array<{ tableCount?: string | number }>;
    const executed =
      Number(rows[0]?.tableCount) === 1
        ? (
            (await this.dataSource.query(`SELECT name FROM \`${tableName}\``)) as Array<{
              name?: string;
            }>
          ).map(({ name }) => name)
        : [];
    const names = new Set(executed);
    const pending = this.dataSource.migrations
      .map(({ name }) => name)
      .filter((name) => !names.has(name));
    if (pending.length > 0) {
      throw new Error(`Pending migrations: ${pending.join(', ')}. Run npm run migration:run.`);
    }
  }
}
