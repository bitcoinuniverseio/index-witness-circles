import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfiguration } from '../config/configuration';
import { BitcoinBlock, BitcoinOutput, BitcoinTransaction } from '../protocol';

interface RpcErrorBody {
  code: number;
  message: string;
}

interface RpcResponse<T> {
  result: T;
  error: RpcErrorBody | null;
}

interface RpcScriptPubKey {
  hex: string;
  type?: string;
  address?: string;
}

interface RpcPrevout {
  value: number;
  height?: number;
  generated?: boolean;
  scriptPubKey: RpcScriptPubKey;
}

interface RpcVin {
  txid?: string;
  vout?: number;
  coinbase?: string;
  sequence: number;
  txinwitness?: string[];
  prevout?: RpcPrevout;
}

interface RpcVout {
  value: number;
  n: number;
  scriptPubKey: RpcScriptPubKey;
}

interface RpcTransaction {
  txid: string;
  hash?: string;
  version: number;
  locktime: number;
  size?: number;
  vsize?: number;
  weight?: number;
  hex?: string;
  blockhash?: string;
  confirmations?: number;
  vin: RpcVin[];
  vout: RpcVout[];
}

interface RpcBlock {
  hash: string;
  height: number;
  previousblockhash?: string;
  time: number;
  mediantime: number;
  tx: RpcTransaction[];
}

export interface BlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  initialblockdownload: boolean;
  pruned: boolean;
}

export interface RawMempoolEntry {
  vsize: number;
  weight: number;
  time: number;
  height: number;
  descendantcount: number;
  descendantsize: number;
  ancestorcount: number;
  ancestorsize: number;
  fees: { base: number; modified: number; ancestor: number; descendant: number };
  depends: string[];
  spentby: string[];
  'bip125-replaceable': boolean;
  unbroadcast?: boolean;
}

export interface EstimateSmartFeeResult {
  feerate?: number;
  errors?: string[];
  blocks: number;
}

export interface TestMempoolAcceptResult {
  txid: string;
  wtxid: string;
  allowed: boolean;
  vsize?: number;
  fees?: { base: number };
  'reject-reason'?: string;
}

export class BitcoinRpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly rpcCode: number | null,
    message: string,
  ) {
    super(`Bitcoin RPC ${method}: ${message}`);
    this.name = 'BitcoinRpcError';
  }
}

export function btcToSats(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid Bitcoin amount ${value}`);
  return BigInt(Math.round(value * 100_000_000));
}

function normalizeOutput(output: RpcVout): BitcoinOutput {
  return {
    valueSats: btcToSats(output.value),
    scriptPubKeyHex: output.scriptPubKey.hex.toLowerCase(),
    ...(output.scriptPubKey.type ? { type: output.scriptPubKey.type } : {}),
    ...(output.scriptPubKey.address ? { address: output.scriptPubKey.address } : {}),
  };
}

function normalizeTransaction(transaction: RpcTransaction): BitcoinTransaction {
  return {
    txid: transaction.txid.toLowerCase(),
    ...(transaction.hash ? { wtxid: transaction.hash.toLowerCase() } : {}),
    version: transaction.version,
    locktime: transaction.locktime,
    ...(transaction.size !== undefined ? { size: transaction.size } : {}),
    ...(transaction.vsize !== undefined ? { vsize: transaction.vsize } : {}),
    ...(transaction.weight !== undefined ? { weight: transaction.weight } : {}),
    ...(transaction.hex ? { hex: transaction.hex.toLowerCase() } : {}),
    ...(transaction.blockhash ? { blockHash: transaction.blockhash.toLowerCase() } : {}),
    ...(transaction.confirmations !== undefined
      ? { confirmations: transaction.confirmations }
      : {}),
    inputs: transaction.vin.map((input) => ({
      ...(input.txid ? { txid: input.txid.toLowerCase() } : {}),
      ...(input.vout !== undefined ? { vout: input.vout } : {}),
      ...(input.coinbase ? { coinbase: input.coinbase.toLowerCase() } : {}),
      sequence: input.sequence,
      witness: input.txinwitness?.map((item) => item.toLowerCase()) ?? [],
      ...(input.prevout
        ? {
            prevout: {
              valueSats: btcToSats(input.prevout.value),
              scriptPubKeyHex: input.prevout.scriptPubKey.hex.toLowerCase(),
              ...(input.prevout.scriptPubKey.type ? { type: input.prevout.scriptPubKey.type } : {}),
              ...(input.prevout.scriptPubKey.address
                ? { address: input.prevout.scriptPubKey.address }
                : {}),
              ...(input.prevout.height !== undefined
                ? { blockHeight: input.prevout.height, confirmed: true }
                : {}),
            },
          }
        : {}),
    })),
    outputs: [...transaction.vout].sort((a, b) => a.n - b.n).map(normalizeOutput),
  };
}

@Injectable()
export class BitcoinRpcClient {
  private readonly rpcUrl: string;
  private readonly authorization: string;
  private readonly timeoutMs: number;

  constructor(configService: ConfigService<AppConfiguration, true>) {
    const config = configService.get('bitcoin', { infer: true });
    this.rpcUrl = config.rpcUrl;
    this.authorization = `Basic ${Buffer.from(`${config.rpcUser}:${config.rpcPassword}`).toString('base64')}`;
    this.timeoutMs = config.rpcTimeoutMs;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { authorization: this.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'witness-indexer', method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw new BitcoinRpcError(method, null, `HTTP ${response.status}`);
      const body = (await response.json()) as RpcResponse<T>;
      if (body.error) throw new BitcoinRpcError(method, body.error.code, body.error.message);
      return body.result;
    } catch (error) {
      if (error instanceof BitcoinRpcError) throw error;
      throw new BitcoinRpcError(
        method,
        null,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  getBlockchainInfo(): Promise<BlockchainInfo> {
    return this.call<BlockchainInfo>('getblockchaininfo');
  }

  getBlockCount(): Promise<number> {
    return this.call<number>('getblockcount');
  }

  getBestBlockHash(): Promise<string> {
    return this.call<string>('getbestblockhash');
  }

  getBlockHash(height: number): Promise<string> {
    return this.call<string>('getblockhash', [height]);
  }

  getBlockHeader(hash: string): Promise<{ hash: string; height: number; confirmations: number }> {
    return this.call('getblockheader', [hash, true]);
  }

  async getBlock(hash: string): Promise<BitcoinBlock> {
    const block = await this.call<RpcBlock>('getblock', [hash, 3]);
    return {
      hash: block.hash.toLowerCase(),
      previousBlockHash: block.previousblockhash?.toLowerCase() ?? null,
      height: block.height,
      time: block.time,
      medianTime: block.mediantime,
      transactions: block.tx.map(normalizeTransaction),
    };
  }

  async getRawTransaction(txid: string): Promise<BitcoinTransaction> {
    return normalizeTransaction(await this.call<RpcTransaction>('getrawtransaction', [txid, true]));
  }

  getRawMempool(): Promise<Record<string, RawMempoolEntry>> {
    return this.call<Record<string, RawMempoolEntry>>('getrawmempool', [true]);
  }

  getMempoolEntry(txid: string): Promise<RawMempoolEntry> {
    return this.call<RawMempoolEntry>('getmempoolentry', [txid]);
  }

  estimateSmartFee(
    targetBlocks: number,
    mode: 'CONSERVATIVE' | 'ECONOMICAL' = 'CONSERVATIVE',
  ): Promise<EstimateSmartFeeResult> {
    return this.call<EstimateSmartFeeResult>('estimatesmartfee', [targetBlocks, mode]);
  }

  testMempoolAccept(rawHex: string): Promise<TestMempoolAcceptResult[]> {
    return this.call<TestMempoolAcceptResult[]>('testmempoolaccept', [[rawHex], 0]);
  }

  async hydratePrevouts(transaction: BitcoinTransaction): Promise<BitcoinTransaction> {
    const parents = new Map<string, BitcoinTransaction>();
    const heights = new Map<string, number>();
    for (const input of transaction.inputs) {
      if (input.coinbase || !input.txid || input.vout === undefined) continue;
      if (input.prevout?.blockHeight !== undefined) continue;
      let parent = parents.get(input.txid);
      if (!parent) {
        parent = await this.getRawTransaction(input.txid);
        parents.set(input.txid, parent);
      }
      const output = parent.outputs[input.vout];
      if (!output) continue;
      let blockHeight: number | undefined;
      if (parent.blockHash) {
        blockHeight = heights.get(parent.blockHash);
        if (blockHeight === undefined) {
          const header = await this.getBlockHeader(parent.blockHash);
          if (header.confirmations > 0) {
            blockHeight = header.height;
            heights.set(parent.blockHash, blockHeight);
          }
        }
      }
      input.prevout = {
        ...output,
        ...(blockHeight === undefined ? { confirmed: false } : { blockHeight, confirmed: true }),
      };
    }
    return transaction;
  }
}
