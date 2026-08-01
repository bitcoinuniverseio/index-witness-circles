import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { BitcoinRpcClient } from '../bitcoin/bitcoin-rpc.client';
import { IndexerCoordinator } from '../indexer/indexer.coordinator';
import { IndexerLeaseService } from '../indexer/indexer-lease.service';
import { IndexerStore, VerifyStateResult } from '../indexer/indexer.store';

@Injectable()
export class AdminCommandService {
  constructor(
    private readonly store: IndexerStore,
    private readonly coordinator: IndexerCoordinator,
    private readonly lease: IndexerLeaseService,
    private readonly rpc: BitcoinRpcClient,
  ) {}

  verify(): Promise<VerifyStateResult> {
    return this.store.verifyState();
  }

  async verifyCore(fromHeight?: number, toHeight?: number): Promise<Record<string, unknown>> {
    const checkpoint = await this.store.getCheckpoint();
    if (!checkpoint) throw new Error('Checkpoint is not initialized');
    const from = Math.max(
      this.store.startHeight,
      fromHeight ?? Math.max(this.store.startHeight, checkpoint.tipHeight - 999),
    );
    const to = Math.min(checkpoint.tipHeight, toHeight ?? checkpoint.tipHeight);
    if (to < from) throw new Error('toHeight must not precede fromHeight');
    if (to - from + 1 > 5_000)
      throw new Error('A Core verification range is limited to 5000 blocks');
    const mismatches: Array<Record<string, unknown>> = [];
    for (let height = from; height <= to; height += 1) {
      const [localHash, coreHash] = await Promise.all([
        this.store.getCanonicalBlockHash(height),
        this.rpc.getBlockHash(height),
      ]);
      if (localHash !== coreHash) mismatches.push({ height, localHash, coreHash });
    }
    return { ok: mismatches.length === 0, fromHeight: from, toHeight: to, mismatches };
  }

  async repair(): Promise<VerifyStateResult> {
    const handle = await this.lease.requireLeadership();
    await this.store.rebuildDerivedData(handle);
    return this.store.verifyState();
  }

  async reindex(fromHeight = this.store.startHeight): Promise<Record<string, unknown>> {
    return this.runJob('reindex', fromHeight, null, () => this.coordinator.reindexFrom(fromHeight));
  }

  async reindexRange(fromHeight: number, toHeight: number): Promise<Record<string, unknown>> {
    return this.runJob('reindex-range', fromHeight, toHeight, () =>
      this.coordinator.reindexRange(fromHeight, toHeight),
    );
  }

  async sync(): Promise<Record<string, unknown>> {
    await this.coordinator.syncToTip(true);
    return { checkpoint: await this.store.getCheckpoint() };
  }

  private async runJob(
    kind: string,
    fromHeight: number,
    toHeight: number | null,
    work: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const id = randomUUID();
    await this.store.createAdminJob({ id, kind, fromHeight, toHeight });
    try {
      const result = await work();
      await this.store.finishAdminJob(id, result, null);
      return { jobId: id, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.finishAdminJob(id, null, message);
      throw error;
    }
  }
}
