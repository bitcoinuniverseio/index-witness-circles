import { Injectable } from '@nestjs/common';

export interface SyncStatusSnapshot {
  initialized: boolean;
  syncing: boolean;
  ready: boolean;
  leader: boolean;
  leaseFencingToken: string | null;
  nodeHeight: number | null;
  indexedHeight: number | null;
  lastBlockAt: string | null;
  lastMempoolAt: string | null;
  mempoolSyncing: boolean;
  mempoolSequence: number | null;
  lastMempoolError: string | null;
  lastVerificationAt: string | null;
  lastError: string | null;
}

@Injectable()
export class SyncStatusService {
  private state: SyncStatusSnapshot = {
    initialized: false,
    syncing: false,
    ready: false,
    leader: false,
    leaseFencingToken: null,
    nodeHeight: null,
    indexedHeight: null,
    lastBlockAt: null,
    lastMempoolAt: null,
    mempoolSyncing: false,
    mempoolSequence: null,
    lastMempoolError: null,
    lastVerificationAt: null,
    lastError: null,
  };

  patch(patch: Partial<SyncStatusSnapshot>): void {
    this.state = { ...this.state, ...patch };
  }

  recordVerification(): void {
    this.patch({ lastVerificationAt: new Date().toISOString() });
  }

  snapshot(): SyncStatusSnapshot {
    return { ...this.state };
  }
}
