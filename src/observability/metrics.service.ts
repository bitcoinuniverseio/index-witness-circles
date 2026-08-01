import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { SyncStatusService } from '../indexer/sync-status.service';

@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly circles: Counter<'participants'>;
  readonly closures: Counter<'reason'>;
  readonly mempool: Counter<'status'>;
  readonly reorgs: Counter<'result'>;
  readonly indexedHeight: Gauge;
  readonly nodeHeight: Gauge;
  readonly ready: Gauge;
  readonly leader: Gauge;

  constructor(private readonly syncStatus: SyncStatusService) {
    collectDefaultMetrics({ register: this.registry, prefix: 'witness_' });
    this.httpRequests = new Counter({
      name: 'witness_http_requests_total',
      help: 'HTTP requests handled',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });
    this.httpDuration = new Histogram({
      name: 'witness_http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
    this.circles = new Counter({
      name: 'witness_circles_total',
      help: 'Confirmed WITC Circles',
      labelNames: ['participants'],
      registers: [this.registry],
    });
    this.closures = new Counter({
      name: 'witness_lineage_closures_total',
      help: 'Confirmed lineage closures',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    this.mempool = new Counter({
      name: 'witness_mempool_events_total',
      help: 'Local mempool observations',
      labelNames: ['status'],
      registers: [this.registry],
    });
    this.reorgs = new Counter({
      name: 'witness_reorgs_total',
      help: 'Detected chain reorganizations',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.indexedHeight = new Gauge({
      name: 'witness_indexed_height',
      help: 'Latest indexed block height',
      registers: [this.registry],
      collect: (): void => this.indexedHeight.set(this.syncStatus.snapshot().indexedHeight ?? -1),
    });
    this.nodeHeight = new Gauge({
      name: 'witness_node_height',
      help: 'Latest observed Bitcoin Core height',
      registers: [this.registry],
      collect: (): void => this.nodeHeight.set(this.syncStatus.snapshot().nodeHeight ?? -1),
    });
    this.ready = new Gauge({
      name: 'witness_ready',
      help: 'Readiness state',
      registers: [this.registry],
      collect: (): void => this.ready.set(this.syncStatus.snapshot().ready ? 1 : 0),
    });
    this.leader = new Gauge({
      name: 'witness_ingester_leader',
      help: 'Canonical ingester leadership state',
      registers: [this.registry],
      collect: (): void => this.leader.set(this.syncStatus.snapshot().leader ? 1 : 0),
    });
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  @OnEvent('witness.circle')
  onCircle(circle: { participantCount?: number }): void {
    this.circles.inc({ participants: String(circle.participantCount ?? 'unknown') });
  }

  @OnEvent('witness.lineage.closed')
  onClosure(closure: { reason?: string }): void {
    this.closures.inc({ reason: closure.reason ?? 'unknown' });
  }

  @OnEvent('witness.mempool')
  onMempool(event: { protocolStatus?: string }): void {
    this.mempool.inc({ status: event.protocolStatus ?? 'none' });
  }

  @OnEvent('witness.reorg')
  onReorg(): void {
    this.reorgs.inc({ result: 'detected' });
  }
}
