import { OnEvent } from '@nestjs/event-emitter';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { AppConfiguration } from '../config/configuration';

@WebSocketGateway({ namespace: '/v1/witness/ws', transports: ['websocket'], cors: false })
export class WitnessGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  private readonly windowMs: number;
  private readonly maxMessages: number;
  private readonly maxRooms: number;

  constructor(configService: ConfigService<AppConfiguration, true>) {
    const security = configService.get('security', { infer: true });
    this.windowMs = security.websocketRateLimitWindowMs;
    this.maxMessages = security.websocketRateLimitMax;
    this.maxRooms = security.websocketMaxRoomsPerConnection;
  }

  handleConnection(socket: Socket): void {
    let windowStart = Date.now();
    let messages = 0;
    socket.use((_event, next) => {
      const now = Date.now();
      if (now - windowStart >= this.windowMs) {
        windowStart = now;
        messages = 0;
      }
      messages += 1;
      if (messages > this.maxMessages) return next(new Error('websocket_rate_limit'));
      next();
    });
  }

  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body?: { circleTxid?: string; lineageId?: string },
  ): Promise<{ ok: boolean; rooms: string[] }> {
    const rooms: string[] = [];
    if (body?.circleTxid && /^[0-9a-fA-F]{64}$/.test(body.circleTxid)) {
      rooms.push(`circle:${body.circleTxid.toLowerCase()}`);
    }
    if (body?.lineageId && /^[0-9a-fA-F]{64}$/.test(body.lineageId)) {
      rooms.push(`lineage:${body.lineageId.toLowerCase()}`);
    }
    const joinedCount = Math.max(0, socket.rooms.size - 1);
    const newRooms = rooms.filter((room) => !socket.rooms.has(room));
    if (rooms.length === 0 || joinedCount + newRooms.length > this.maxRooms) {
      return { ok: false, rooms: [] };
    }
    for (const room of newRooms) await socket.join(room);
    return { ok: true, rooms };
  }

  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body?: { room?: string },
  ): Promise<{ ok: boolean }> {
    if (!body?.room || !/^(?:circle|lineage):[0-9a-fA-F]{64}$/.test(body.room)) {
      return { ok: false };
    }
    await socket.leave(body.room.toLowerCase());
    return { ok: true };
  }

  @OnEvent('witness.block')
  onBlock(payload: unknown): void {
    this.server.emit('block', payload);
  }

  @OnEvent('witness.circle')
  onCircle(payload: { txid?: string }): void {
    this.server.emit('circle', payload);
    if (payload.txid) this.server.to(`circle:${payload.txid}`).emit('circle', payload);
  }

  @OnEvent('witness.mempool')
  onMempool(payload: unknown): void {
    this.server.emit('mempool', payload);
  }

  @OnEvent('witness.replacement')
  onReplacement(payload: unknown): void {
    this.server.emit('replacement', payload);
  }

  @OnEvent('witness.reorg')
  onReorg(payload: unknown): void {
    this.server.emit('reorg', payload);
  }

  @OnEvent('witness.lineage.closed')
  onLineageClosed(payload: { lineageId?: string }): void {
    this.server.emit('lineage.closed', payload);
    if (payload.lineageId) {
      this.server.to(`lineage:${payload.lineageId}`).emit('lineage.closed', payload);
    }
  }
}
