import { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { IncomingMessage } from 'node:http';
import { Server, ServerOptions, Socket } from 'socket.io';
import { AppConfiguration } from '../config/configuration';

export class WitnessSocketAdapter extends IoAdapter {
  private total = 0;
  private readonly byIp = new Map<string, number>();

  constructor(
    app: INestApplicationContext,
    private readonly security: AppConfiguration['security'],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      maxHttpBufferSize: this.security.websocketMaxMessageBytes,
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null, success: boolean) => void,
      ) => {
        const ip = request.socket.remoteAddress ?? 'unknown';
        const allowed =
          this.total < this.security.websocketMaxConnections &&
          (this.byIp.get(ip) ?? 0) < this.security.websocketMaxConnectionsPerIp;
        callback(allowed ? null : 'connection_limit', allowed);
      },
    }) as Server;
    server.on('connection', (socket: Socket) => {
      const ip = socket.handshake.address || 'unknown';
      this.total += 1;
      this.byIp.set(ip, (this.byIp.get(ip) ?? 0) + 1);
      socket.once('disconnect', () => {
        this.total = Math.max(0, this.total - 1);
        const remaining = Math.max(0, (this.byIp.get(ip) ?? 1) - 1);
        if (remaining === 0) this.byIp.delete(ip);
        else this.byIp.set(ip, remaining);
      });
    });
    return server;
  }
}
