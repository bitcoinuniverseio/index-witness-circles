import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminApiKeyGuard } from '../common/admin-api-key.guard';
import { AdminCommandService } from './admin-command.service';
import { ReindexDto, ReindexRangeDto, VerifyCoreDto } from './query.dto';

@ApiTags('witness-admin')
@ApiBearerAuth()
@UseGuards(AdminApiKeyGuard)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
@Controller('v1/witness/admin')
export class AdminController {
  constructor(private readonly commands: AdminCommandService) {}

  @Post('sync')
  @ApiOperation({ summary: 'Synchronize blocks and reconcile the canonical chain' })
  sync(): ReturnType<AdminCommandService['sync']> {
    return this.commands.sync();
  }

  @Post('verify')
  @ApiOperation({ summary: 'Recompute and compare the canonical WITC state root' })
  verify(): ReturnType<AdminCommandService['verify']> {
    return this.commands.verify();
  }

  @Post('verify-core')
  @ApiOperation({ summary: 'Cross-check canonical block hashes against Bitcoin Core' })
  verifyCore(@Body() body: VerifyCoreDto): ReturnType<AdminCommandService['verifyCore']> {
    return this.commands.verifyCore(body.fromHeight, body.toHeight);
  }

  @Post('repair')
  @ApiOperation({ summary: 'Rebuild derived search and statistics projections' })
  repair(): ReturnType<AdminCommandService['repair']> {
    return this.commands.repair();
  }

  @Post('reindex')
  @ApiOperation({ summary: 'Roll back and replay from a specified height through the node tip' })
  reindex(@Body() body: ReindexDto): ReturnType<AdminCommandService['reindex']> {
    return this.commands.reindex(body.fromHeight);
  }

  @Post('reindex-range')
  @ApiOperation({ summary: 'Replay a range and then restore canonical state through the node tip' })
  reindexRange(@Body() body: ReindexRangeDto): ReturnType<AdminCommandService['reindexRange']> {
    return this.commands.reindexRange(body.fromHeight, body.toHeight);
  }
}
