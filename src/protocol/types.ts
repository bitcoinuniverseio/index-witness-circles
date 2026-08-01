import { WitnessNetwork } from './constants';

export interface WitnessEnvelope {
  version: 1;
  network: WitnessNetwork;
  opcode: 1;
  participantCount: number;
  contextHash: string;
  dataHex: string;
  scriptHex: string;
}

export type ParseErrorCode =
  | 'NON_CANONICAL_OP_RETURN'
  | 'MARKER_LENGTH'
  | 'UNKNOWN_NETWORK'
  | 'UNKNOWN_OPCODE'
  | 'INVALID_PARTICIPANT_COUNT'
  | 'ZERO_CONTEXT_HASH';

export type ParseResult =
  | { kind: 'not_protocol' }
  | { kind: 'malformed'; code: ParseErrorCode; detail: string; dataHex?: string }
  | {
      kind: 'unknown_version';
      version: number;
      networkByte: number;
      opcodeByte: number;
      participantCount: number;
      contextHash: string;
      dataHex: string;
    }
  | { kind: 'parsed'; envelope: WitnessEnvelope };

export interface BitcoinPrevout {
  valueSats: bigint;
  scriptPubKeyHex: string;
  type?: string;
  address?: string;
  blockHeight?: number;
  confirmed?: boolean;
}

export interface BitcoinInput {
  txid?: string;
  vout?: number;
  coinbase?: string;
  sequence: number;
  witness: string[];
  prevout?: BitcoinPrevout;
}

export interface BitcoinOutput {
  valueSats: bigint;
  scriptPubKeyHex: string;
  type?: string;
  address?: string;
}

export interface BitcoinTransaction {
  txid: string;
  wtxid?: string;
  version: number;
  locktime: number;
  size?: number;
  vsize?: number;
  weight?: number;
  hex?: string;
  blockHash?: string;
  confirmations?: number;
  inputs: BitcoinInput[];
  outputs: BitcoinOutput[];
}

export interface BitcoinBlock {
  hash: string;
  previousBlockHash: string | null;
  height: number;
  time: number;
  medianTime: number;
  transactions: BitcoinTransaction[];
}

export interface Outpoint {
  txid: string;
  vout: number;
}

export type LineageStatus = 'active' | 'closed';
export type ShardStatus = 'active' | 'spent' | 'closed';

export interface LineageRecord {
  id: string;
  genesisTxid: string;
  genesisVout: number;
  currentTxid: string | null;
  currentVout: number | null;
  status: LineageStatus;
  circleCount: number;
  lastCircleTxid: string | null;
}

export interface ShardRecord extends Outpoint {
  lineageId: string;
  valueSats: bigint;
  scriptPubKeyHex: string;
  scriptHash: string;
  address: string | null;
  status: ShardStatus;
  createdCircleTxid: string;
  previousTxid: string | null;
  previousVout: number | null;
}

export interface StateLookup {
  shardByOutpoint(outpoint: Outpoint): Promise<ShardRecord | null>;
  lineageById(lineageId: string): Promise<LineageRecord | null>;
}

export interface CircleMemberTransition {
  slot: number;
  inputVin: number;
  outputVout: number;
  lineageId: string;
  fresh: boolean;
  previousCircleTxid: string | null;
  input: Required<Pick<BitcoinInput, 'txid' | 'vout'>> & { prevout: BitcoinPrevout };
  output: BitcoinOutput;
  feeShareSats: bigint;
}

export interface CircleTransition {
  kind: 'circle';
  txid: string;
  envelope: WitnessEnvelope;
  feeSats: bigint;
  members: CircleMemberTransition[];
}

export interface ClosureTransition {
  lineageId: string;
  shard: ShardRecord;
  spendingTxid: string;
  spendingVin: number;
  reason: 'ordinary_spend' | 'invalid_protocol_spend' | 'unknown_version_spend';
}

export type EvaluationCode =
  | ParseErrorCode
  | 'MULTIPLE_PROTOCOL_OUTPUTS'
  | 'PROTOCOL_OUTPUT_NOT_VOUT_ZERO'
  | 'NETWORK_MISMATCH'
  | 'TRANSACTION_VERSION'
  | 'LOCKTIME_MISMATCH'
  | 'SEQUENCE_MISMATCH'
  | 'PARTICIPANT_COUNT_MISMATCH'
  | 'OUTPUT_COUNT_MISMATCH'
  | 'MARKER_VALUE'
  | 'COINBASE_INPUT'
  | 'MISSING_PREVOUT'
  | 'UNCONFIRMED_PREVOUT'
  | 'SAME_BLOCK_PREVOUT'
  | 'NON_P2TR_PREVOUT'
  | 'DUPLICATE_OUTPOINT'
  | 'DUPLICATE_SCRIPT'
  | 'INPUT_ORDER'
  | 'INVALID_SIGHASH'
  | 'NON_CURRENT_SHARD'
  | 'LINEAGE_STATE_MISMATCH'
  | 'DUPLICATE_LINEAGE'
  | 'VALUE_RANGE'
  | 'NEGATIVE_FEE'
  | 'SUCCESSOR_SCRIPT_MISMATCH'
  | 'SUCCESSOR_VALUE_MISMATCH'
  | 'SUCCESSOR_BELOW_MINIMUM';

export type EvaluationResult =
  | { classification: 'none'; closures: ClosureTransition[] }
  | {
      classification: 'observed';
      version: number;
      networkByte: number;
      opcodeByte: number;
      participantCount: number;
      contextHash: string;
      dataHex: string;
      closures: ClosureTransition[];
    }
  | {
      classification: 'invalid';
      code: EvaluationCode;
      detail: string;
      dataHex?: string;
      envelope?: WitnessEnvelope;
      closures: ClosureTransition[];
    }
  | { classification: 'valid'; envelope: WitnessEnvelope; transition: CircleTransition };

export interface EvaluationContext {
  network: WitnessNetwork;
  blockHeight: number;
  confirmed: boolean;
  lookup: StateLookup;
}

export function outpointKey(outpoint: Outpoint): string {
  return `${outpoint.txid.toLowerCase()}:${outpoint.vout}`;
}
