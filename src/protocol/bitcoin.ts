import { createHash } from 'node:crypto';
import { BitcoinInput, Outpoint } from './types';

export function isP2trScript(scriptHex: string): boolean {
  return /^5120[0-9a-fA-F]{64}$/.test(scriptHex);
}

export function scriptHash(scriptHex: string): string {
  if (!/^[0-9a-fA-F]*$/.test(scriptHex) || scriptHex.length % 2 !== 0) {
    throw new Error('scriptHex must contain complete hexadecimal bytes');
  }
  return createHash('sha256').update(Buffer.from(scriptHex, 'hex')).digest('hex');
}

export function usesAllowedTaprootKeyPathSighash(input: BitcoinInput): boolean {
  if (input.witness.length !== 1) return false;
  const signature = input.witness[0] ?? '';
  return (
    /^[0-9a-fA-F]{128}$/.test(signature) ||
    (/^[0-9a-fA-F]{130}$/.test(signature) && signature.slice(-2).toLowerCase() === '01')
  );
}

export function compareOutpoints(left: Outpoint, right: Outpoint): number {
  const leftTxid = left.txid.toLowerCase();
  const rightTxid = right.txid.toLowerCase();
  if (leftTxid < rightTxid) return -1;
  if (leftTxid > rightTxid) return 1;
  return left.vout - right.vout;
}

export function deriveLineageId(genesis: Outpoint): string {
  if (!/^[0-9a-fA-F]{64}$/.test(genesis.txid)) throw new Error('Invalid genesis txid');
  if (!Number.isInteger(genesis.vout) || genesis.vout < 0 || genesis.vout > 0xffff_ffff) {
    throw new Error('Invalid genesis vout');
  }
  const wireOutpoint = Buffer.alloc(36);
  Buffer.from(genesis.txid, 'hex').reverse().copy(wireOutpoint, 0);
  wireOutpoint.writeUInt32LE(genesis.vout, 32);
  return createHash('sha256')
    .update(Buffer.from('WITC/lineage/v1', 'ascii'))
    .update(wireOutpoint)
    .digest('hex');
}
