import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from '../common/admin-api-key.guard';
import { IndexerModule } from '../indexer/indexer.module';
import { AdminCommandService } from './admin-command.service';
import { AdminController } from './admin.controller';
import { BlockEventsService } from './block-events.service';
import { ExplorerController } from './explorer.controller';
import { WitnessController } from './witness.controller';
import { WitnessGateway } from './witness.gateway';
import { WitnessQueryService } from './witness-query.service';

@Module({
  imports: [IndexerModule],
  controllers: [WitnessController, ExplorerController, AdminController],
  providers: [
    WitnessQueryService,
    BlockEventsService,
    AdminCommandService,
    AdminApiKeyGuard,
    WitnessGateway,
  ],
})
export class ApiModule {}
