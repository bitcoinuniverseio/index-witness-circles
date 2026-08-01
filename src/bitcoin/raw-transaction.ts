import { Transaction } from 'bitcoinjs-lib';
import { BitcoinTransaction } from '../protocol';

export function decodeRawTransaction(raw: Buffer | string): BitcoinTransaction {
  const hex = typeof raw === 'string' ? raw : raw.toString('hex');
  const transaction = Transaction.fromHex(hex);
  return {
    txid: transaction.getId(),
    wtxid: Buffer.from(transaction.getHash(true)).reverse().toString('hex'),
    version: transaction.version,
    locktime: transaction.locktime,
    size: transaction.byteLength(),
    weight: transaction.weight(),
    vsize: transaction.virtualSize(),
    hex: hex.toLowerCase(),
    inputs: transaction.ins.map((input) => ({
      txid: Buffer.from(input.hash).reverse().toString('hex'),
      vout: input.index,
      sequence: input.sequence,
      witness: input.witness.map((item) => Buffer.from(item).toString('hex')),
    })),
    outputs: transaction.outs.map((output) => ({
      valueSats: output.value,
      scriptPubKeyHex: Buffer.from(output.script).toString('hex'),
    })),
  };
}
