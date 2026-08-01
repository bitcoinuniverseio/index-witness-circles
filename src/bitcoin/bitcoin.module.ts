import { Module } from '@nestjs/common';
import { BitcoinRpcClient } from './bitcoin-rpc.client';
import { BitcoinZmqService } from './bitcoin-zmq.service';

@Module({
  providers: [BitcoinRpcClient, BitcoinZmqService],
  exports: [BitcoinRpcClient, BitcoinZmqService],
})
export class BitcoinModule {}
