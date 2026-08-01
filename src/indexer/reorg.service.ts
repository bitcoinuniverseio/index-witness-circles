import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BitcoinRpcClient } from '../bitcoin/bitcoin-rpc.client';
import { ReorgEntity } from '../database/entities';
import { IndexerLeaseHandle, IndexerLeaseService } from './indexer-lease.service';
import { IndexerStore } from './indexer.store';

export interface ReorgResult {
  reorged: boolean;
  oldTipHash?: string;
  newTipHash?: string;
  forkHeight?: number;
  depth?: number;
}

@Injectable()
export class ReorgService {
  private readonly logger = new Logger(ReorgService.name);

  constructor(
    private readonly rpc: BitcoinRpcClient,
    private readonly store: IndexerStore,
    private readonly events: EventEmitter2,
    private readonly lease: IndexerLeaseService,
  ) {}

  async reconcileCanonicalChain(handle: IndexerLeaseHandle): Promise<ReorgResult> {
    const checkpoint = await this.store.getCheckpoint();
    if (!checkpoint) {
      return { reorged: false };
    }
    const nodeHeight = await this.rpc.getBlockCount();
    if (checkpoint.tipHeight < this.store.startHeight) {
      const boundaryHeight = this.store.startHeight - 1;
      if (boundaryHeight >= 0) {
        const boundaryHash =
          nodeHeight >= boundaryHeight ? await this.rpc.getBlockHash(boundaryHeight) : null;
        if (checkpoint.tipHash !== boundaryHash || checkpoint.boundaryParentHash !== boundaryHash) {
          await this.store.setBoundaryParentHash(boundaryHash, handle);
        }
      }
      return { reorged: false };
    }
    if (!checkpoint.tipHash) return { reorged: false };
    if (checkpoint.tipHeight <= nodeHeight) {
      const canonicalAtTip = await this.rpc.getBlockHash(checkpoint.tipHeight);
      if (canonicalAtTip === checkpoint.tipHash) return { reorged: false };
    }

    const oldTipHash = checkpoint.tipHash;
    let forkHeight = Math.min(checkpoint.tipHeight - 1, nodeHeight);
    if (checkpoint.tipHeight > nodeHeight) forkHeight = nodeHeight;
    while (forkHeight >= this.store.startHeight) {
      const [localHash, nodeHash] = await Promise.all([
        this.store.getCanonicalBlockHash(forkHeight),
        this.rpc.getBlockHash(forkHeight),
      ]);
      if (localHash === nodeHash) break;
      forkHeight -= 1;
    }
    if (forkHeight < this.store.startHeight) forkHeight = this.store.startHeight - 1;
    const newTipHash = await this.rpc.getBestBlockHash();
    const depth = checkpoint.tipHeight - forkHeight;
    const reorg = await this.lease.fencedTransaction(handle, 'READ COMMITTED', async (manager) =>
      manager.save(
        ReorgEntity,
        manager.create(ReorgEntity, {
          oldTipHash,
          newTipHash,
          forkHeight,
          depth,
          status: 'rolling_back',
          orphanedBlocks: 0,
          replayedBlocks: 0,
          completedAt: null,
        }),
      ),
    );
    this.logger.warn({ event: 'reorg_detected', oldTipHash, newTipHash, forkHeight, depth });
    try {
      const orphanedBlocks = await this.store.rollbackToHeight(forkHeight, handle);
      if (forkHeight === this.store.startHeight - 1) {
        const boundary =
          forkHeight >= 0 && forkHeight <= nodeHeight
            ? await this.rpc.getBlockHash(forkHeight)
            : null;
        await this.store.setBoundaryParentHash(boundary, handle);
      }
      reorg.status = 'replaying';
      reorg.orphanedBlocks = orphanedBlocks;
      await this.lease.fencedTransaction(handle, 'READ COMMITTED', async (manager) => {
        await manager.save(reorg);
      });
      const result = { reorged: true, oldTipHash, newTipHash, forkHeight, depth };
      this.events.emit('witness.reorg', result);
      return result;
    } catch (error) {
      await this.lease
        .fencedTransaction(handle, 'READ COMMITTED', async (manager) => {
          reorg.status = 'failed';
          reorg.completedAt = new Date();
          await manager.save(reorg);
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async completeReplay(
    forkHeight: number,
    newTipHeight: number,
    handle: IndexerLeaseHandle,
  ): Promise<void> {
    await this.lease.fencedTransaction(handle, 'READ COMMITTED', async (manager) => {
      const reorg = await manager.findOne(ReorgEntity, {
        where: { status: 'replaying', forkHeight },
        order: { id: 'DESC' },
      });
      if (!reorg) return;
      reorg.status = 'complete';
      reorg.replayedBlocks = Math.max(0, newTipHeight - forkHeight);
      reorg.completedAt = new Date();
      await manager.save(reorg);
    });
  }
}
