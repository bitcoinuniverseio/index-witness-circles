import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { BlockEventsService } from './block-events.service';

@ApiTags('explorer')
@Controller('v1')
export class ExplorerController {
  constructor(private readonly blockEvents: BlockEventsService) {}

  @Get('checkpoint')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Indexer checkpoint height and hash from the authoritative database' })
  checkpoint(): Promise<Record<string, unknown>> {
    return this.blockEvents.checkpoint();
  }

  @Get('explorer/blocks/:height/events')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Applied canonical Witness Circles events in one block (universe-block-events-v1)',
  })
  @ApiParam({ name: 'height', schema: { type: 'string', pattern: '^[0-9]{1,10}$' } })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 500 },
  })
  @ApiQuery({ name: 'cursor', required: false, schema: { type: 'string' } })
  blockEventsPage(
    @Param('height') height: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<Record<string, unknown>> {
    return this.blockEvents.blockEvents(height, limit, cursor);
  }
}
