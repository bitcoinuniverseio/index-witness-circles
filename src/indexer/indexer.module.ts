import { Module } from '@nestjs/common';
import { BitcoinModule } from '../bitcoin/bitcoin.module';
import { WitnessStateEngine } from '../protocol';
import { IndexerCoordinator } from './indexer.coordinator';
import { IndexerLeaseService } from './indexer-lease.service';
import { IndexerStore } from './indexer.store';
import { MempoolService } from './mempool.service';
import { ReorgService } from './reorg.service';
import { SyncStatusService } from './sync-status.service';

@Module({
  imports: [BitcoinModule],
  providers: [
    WitnessStateEngine,
    IndexerLeaseService,
    IndexerStore,
    MempoolService,
    ReorgService,
    SyncStatusService,
    IndexerCoordinator,
  ],
  exports: [
    WitnessStateEngine,
    IndexerLeaseService,
    IndexerStore,
    MempoolService,
    ReorgService,
    SyncStatusService,
    IndexerCoordinator,
    BitcoinModule,
  ],
})
export class IndexerModule {}
