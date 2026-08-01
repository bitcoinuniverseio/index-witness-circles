import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppConfiguration } from '../config/configuration';
import { DatabaseMigrationGuard } from './database-migration.guard';
import { databaseOptions } from './options';

@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfiguration, true>) => {
        const database = configService.get('database', { infer: true });
        return {
          ...databaseOptions({ database }),
          retryAttempts: 10,
          retryDelay: 2_000,
          migrationsRun: false,
        };
      },
    }),
  ],
  providers: [DatabaseMigrationGuard],
  exports: [TypeOrmModule],
})
export class DatabaseModule {}
