import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { BitcoinRpcClient } from '../bitcoin/bitcoin-rpc.client';
import { BitcoinZmqService, SequenceNotification } from '../bitcoin/bitcoin-zmq.service';
import { decodeRawTransaction } from '../bitcoin/raw-transaction';
import { AppConfiguration } from '../config/configuration';
import { BitcoinBlock, parseWitnessScript } from '../protocol';
import {
  IndexerLeaseHandle,
  IndexerLeaseLostError,
  IndexerLeaseService,
  IndexerLeaseUnavailableError,
} from './indexer-lease.service';
import { IndexerStore } from './indexer.store';
import { MempoolService } from './mempool.service';
import { ReorgService } from './reorg.service';
import { SyncStatusService } from './sync-status.service';

const CORE_CHAINS: Record<AppConfiguration['network'], string[]> = {
  mainnet: ['main'],
  testnet3: ['test'],
  signet: ['signet'],
  regtest: ['regtest'],
};

@Injectable()
export class IndexerCoordinator implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(IndexerCoordinator.name);
  private readonly network: AppConfiguration['network'];
  private readonly config: AppConfiguration['indexer'];
  private blockTimer: NodeJS.Timeout | null = null;
  private mempoolTimer: NodeJS.Timeout | null = null;
  private syncing = false;
  private mempoolSyncing = false;
  private stopping = false;

  constructor(
    configService: ConfigService<AppConfiguration, true>,
    private readonly rpc: BitcoinRpcClient,
    private readonly zmq: BitcoinZmqService,
    private readonly store: IndexerStore,
    private readonly mempool: MempoolService,
    private readonly reorg: ReorgService,
    private readonly status: SyncStatusService,
    private readonly events: EventEmitter2,
    private readonly lease: IndexerLeaseService,
  ) {
    this.network = configService.get('network', { infer: true });
    this.config = configService.get('indexer', { infer: true });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.WITNESS_CLI === 'true') return;
    if (!this.config.enabled) {
      this.status.patch({ initialized: true, ready: true, leader: false });
      return;
    }
    const info = await this.rpc.getBlockchainInfo();
    this.assertNetwork(info.chain);
    this.status.patch({ initialized: true, nodeHeight: info.blocks });
    this.zmq.start();
    this.patchLeadership(await this.lease.start());
    void this.syncToTip();
    this.blockTimer = setInterval(() => void this.syncToTip(), this.config.blockPollMs);
    this.mempoolTimer = setInterval(() => void this.syncMempool(), this.config.mempoolPollMs);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.blockTimer) clearInterval(this.blockTimer);
    if (this.mempoolTimer) clearInterval(this.mempoolTimer);
    await this.lease.stop();
  }

  async syncToTip(force = false): Promise<void> {
    if (this.syncing || this.stopping || (!this.config.enabled && !force)) return;
    this.syncing = true;
    let handle: IndexerLeaseHandle | null = null;
    try {
      handle = force ? await this.lease.requireLeadership() : await this.lease.acquireLeadership();
      if (!handle) return this.patchLeadership(null);
      this.patchLeadership(handle);
      this.status.patch({ syncing: true, lastError: null });
      const info = await this.rpc.getBlockchainInfo();
      this.assertNetwork(info.chain);
      if (!(await this.store.getCheckpoint())) {
        const boundary =
          this.store.startHeight > 0
            ? await this.rpc.getBlockHash(this.store.startHeight - 1)
            : null;
        await this.store.ensureCheckpoint(boundary, handle);
      }
      this.status.patch({ nodeHeight: info.blocks });
      const reorg = await this.reorg.reconcileCanonicalChain(handle);
      await this.syncUntil(info.blocks, handle);
      const checkpoint = await this.store.getCheckpoint();
      if (!checkpoint) throw new Error('Checkpoint disappeared during synchronization');
      if (reorg.reorged && reorg.forkHeight !== undefined) {
        await this.reorg.completeReplay(reorg.forkHeight, checkpoint.tipHeight, handle);
      }
      await this.lease.assertLeadership(handle);
      this.status.recordVerification();
      this.status.patch({
        ready: checkpoint.tipHeight >= info.blocks,
        indexedHeight: checkpoint.tipHeight,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof IndexerLeaseLostError || error instanceof IndexerLeaseUnavailableError) {
        this.patchLeadership(null);
      } else {
        this.logger.error({ event: 'block_sync_failed', error: message });
        this.status.patch({ ready: false, lastError: message });
        if (handle) await this.store.markCheckpointError(error, handle).catch(() => undefined);
      }
      if (force) throw error;
    } finally {
      this.syncing = false;
      this.status.patch({ syncing: false });
    }
  }

  async syncMempool(): Promise<void> {
    if (this.mempoolSyncing || this.stopping || !this.config.enabled) return;
    const handle = this.lease.currentLeadership();
    if (!handle) return;
    this.mempoolSyncing = true;
    try {
      const result = await this.mempool.reconcile(this.rpc, handle);
      this.status.patch({ lastMempoolAt: new Date().toISOString() });
      this.logger.debug({ event: 'mempool_reconciled', ...result });
    } catch (error) {
      this.logger.warn({
        event: 'mempool_sync_failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.mempoolSyncing = false;
    }
  }

  async reindexFrom(fromHeight: number): Promise<Record<string, unknown>> {
    return this.reindexRange(fromHeight, undefined);
  }

  async reindexRange(fromHeight: number, toHeight?: number): Promise<Record<string, unknown>> {
    if (this.syncing) throw new Error('Indexer is busy');
    if (fromHeight < this.store.startHeight)
      throw new Error('fromHeight precedes INDEXER_START_HEIGHT');
    if (toHeight !== undefined && toHeight < fromHeight)
      throw new Error('toHeight must not precede fromHeight');
    const handle = await this.lease.requireLeadership();
    this.syncing = true;
    this.status.patch({ syncing: true, ready: false, lastError: null });
    try {
      const nodeHeight = await this.rpc.getBlockCount();
      const rangeEnd = Math.min(toHeight ?? nodeHeight, nodeHeight);
      await this.store.rollbackToHeight(fromHeight - 1, handle);
      await this.syncUntil(rangeEnd, handle);
      if (rangeEnd < nodeHeight) await this.syncUntil(nodeHeight, handle);
      return {
        fromHeight,
        toHeight: rangeEnd,
        restoredTip: nodeHeight,
        checkpoint: await this.store.getCheckpoint(),
      };
    } finally {
      this.syncing = false;
      this.status.patch({ syncing: false });
    }
  }

  private async syncUntil(targetHeight: number, handle: IndexerLeaseHandle): Promise<void> {
    let checkpoint = await this.store.getCheckpoint();
    if (!checkpoint) throw new Error('Checkpoint is not initialized');
    for (let height = checkpoint.tipHeight + 1; height <= targetHeight; height += 1) {
      if (this.stopping) break;
      if (!this.lease.isCurrent(handle)) throw new IndexerLeaseLostError();
      const block = await this.hydrateProtocolCandidates(
        await this.rpc.getBlock(await this.rpc.getBlockHash(height)),
      );
      const result = await this.store.processBlock(block, handle);
      await this.mempool.confirmBlock(block.transactions, handle);
      this.status.patch({ indexedHeight: height, lastBlockAt: new Date().toISOString() });
      this.events.emit('witness.block', result);
      for (const circle of result.circles) this.events.emit('witness.circle', circle);
      for (const closure of result.closures) this.events.emit('witness.lineage.closed', closure);
      checkpoint = (await this.store.getCheckpoint()) ?? checkpoint;
    }
  }

  private async hydrateProtocolCandidates(block: BitcoinBlock): Promise<BitcoinBlock> {
    for (const transaction of block.transactions) {
      const candidate = transaction.outputs.some(
        (output) => parseWitnessScript(output.scriptPubKeyHex).kind !== 'not_protocol',
      );
      if (
        candidate &&
        transaction.inputs.some(
          (input) => !input.coinbase && input.prevout?.blockHeight === undefined,
        )
      ) {
        await this.rpc.hydratePrevouts(transaction);
      }
    }
    return block;
  }

  @OnEvent('witness.leadership.acquired')
  onLeadershipAcquired(handle: IndexerLeaseHandle): void {
    this.patchLeadership(handle);
    if (!this.stopping && this.config.enabled) void this.syncToTip();
  }

  @OnEvent('witness.leadership.lost')
  onLeadershipLost(): void {
    this.patchLeadership(null);
  }

  @OnEvent('bitcoin.hashblock')
  onHashBlock(): void {
    void this.syncToTip();
  }

  @OnEvent('bitcoin.rawtx')
  async onRawTransaction(raw: Buffer): Promise<void> {
    const handle = this.lease.currentLeadership();
    if (!handle) return;
    try {
      const transaction = await this.rpc.hydratePrevouts(decodeRawTransaction(raw));
      let entry;
      try {
        entry = await this.rpc.getMempoolEntry(transaction.txid);
      } catch {
        return;
      }
      await this.mempool.ingest(transaction, handle, entry);
    } catch (error) {
      this.logger.debug({
        event: 'rawtx_ignored',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  @OnEvent('bitcoin.sequence')
  onSequence(notification: SequenceNotification): void {
    if (notification.label === 'R') {
      const handle = this.lease.currentLeadership();
      if (handle) void this.mempool.markSequenceRemoval(notification.txidOrBlockHash, handle);
    } else if (notification.label === 'C' || notification.label === 'D') {
      void this.syncToTip();
    }
  }

  private assertNetwork(chain: string): void {
    if (!CORE_CHAINS[this.network].includes(chain)) {
      throw new Error(`Bitcoin Core chain ${chain} does not match WITNESS_NETWORK=${this.network}`);
    }
  }

  private patchLeadership(handle: IndexerLeaseHandle | null): void {
    this.status.patch({
      leader: handle !== null,
      leaseFencingToken: handle?.fencingToken ?? null,
      ...(handle ? {} : { ready: false }),
    });
  }
}
