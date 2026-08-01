import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import { INDEXER_VERSION, PARSER_VERSION } from '../protocol';
import { SyncStatusService } from '../indexer/sync-status.service';

@ApiTags('operations')
@Controller()
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly status: SyncStatusService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Process liveness' })
  health(): Record<string, unknown> {
    return {
      ok: true,
      version: INDEXER_VERSION,
      parserVersion: PARSER_VERSION,
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Database, leadership, and indexing readiness' })
  async ready(): Promise<Record<string, unknown>> {
    const snapshot = this.status.snapshot();
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({
        ...snapshot,
        ready: false,
        reason: 'database_unavailable',
      });
    }
    if (!snapshot.ready) throw new ServiceUnavailableException(snapshot);
    return { ...snapshot };
  }
}
