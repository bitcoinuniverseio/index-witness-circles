import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Subscriber } from 'zeromq';
import { AppConfiguration } from '../config/configuration';

export interface SequenceNotification {
  txidOrBlockHash: string;
  label: string;
  sequence: bigint | null;
}

@Injectable()
export class BitcoinZmqService implements OnModuleDestroy {
  private readonly logger = new Logger(BitcoinZmqService.name);
  private readonly sockets: Subscriber[] = [];
  private stopping = false;

  constructor(
    private readonly configService: ConfigService<AppConfiguration, true>,
    private readonly events: EventEmitter2,
  ) {}

  start(): void {
    const config = this.configService.get('bitcoin', { infer: true });
    if (config.zmqHashBlock) this.subscribe(config.zmqHashBlock, 'hashblock');
    if (config.zmqRawTx) this.subscribe(config.zmqRawTx, 'rawtx');
    if (config.zmqSequence) this.subscribe(config.zmqSequence, 'sequence');
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const socket of this.sockets) socket.close();
    this.sockets.length = 0;
  }

  private subscribe(endpoint: string, topic: 'hashblock' | 'rawtx' | 'sequence'): void {
    const socket = new Subscriber();
    socket.connect(endpoint);
    socket.subscribe(topic);
    this.sockets.push(socket);
    this.logger.log({ event: 'zmq_connected', endpoint, topic });
    void this.consume(socket, topic);
  }

  private async consume(socket: Subscriber, topic: string): Promise<void> {
    try {
      for await (const frames of socket) {
        if (this.stopping) return;
        const body = frames[1];
        if (!body) continue;
        if (topic === 'hashblock') {
          this.events.emit('bitcoin.hashblock', Buffer.from(body).reverse().toString('hex'));
        } else if (topic === 'rawtx') {
          this.events.emit('bitcoin.rawtx', Buffer.from(body));
        } else {
          this.events.emit('bitcoin.sequence', this.parseSequence(Buffer.from(body)));
        }
      }
    } catch (error) {
      if (!this.stopping) {
        this.logger.error({
          event: 'zmq_error',
          topic,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private parseSequence(body: Buffer): SequenceNotification {
    return {
      txidOrBlockHash: body.length >= 32 ? body.subarray(0, 32).reverse().toString('hex') : '',
      label: body.length >= 33 ? String.fromCharCode(body[32] ?? 0) : '',
      sequence: body.length >= 41 ? body.readBigUInt64LE(33) : null,
    };
  }
}
