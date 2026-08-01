import {
  WITC_MAGIC,
  WITC_MARKER_DATA_BYTES,
  WITC_OPCODE_CIRCLE,
  WITC_VERSION,
  WitnessNetwork,
} from './constants';
import { ParseErrorCode, ParseResult, WitnessEnvelope } from './types';

const MAGIC_HEX = WITC_MAGIC.toString('hex');

function malformed(
  code: ParseErrorCode,
  detail: string,
  data?: Buffer,
): Extract<ParseResult, { kind: 'malformed' }> {
  return {
    kind: 'malformed',
    code,
    detail,
    ...(data ? { dataHex: data.toString('hex') } : {}),
  };
}

export function parseWitnessScript(scriptHex: string): ParseResult {
  if (!/^[0-9a-fA-F]*$/.test(scriptHex) || scriptHex.length % 2 !== 0) {
    return { kind: 'not_protocol' };
  }
  const normalized = scriptHex.toLowerCase();
  const script = Buffer.from(normalized, 'hex');
  if (script[0] !== 0x6a) return { kind: 'not_protocol' };

  const markerAppears = normalized.includes(MAGIC_HEX);
  if (script.length < 2 || script[1] !== WITC_MARKER_DATA_BYTES) {
    return markerAppears
      ? malformed(
          'NON_CANONICAL_OP_RETURN',
          'WITC requires OP_RETURN followed by one direct PUSH40',
        )
      : { kind: 'not_protocol' };
  }
  if (script.length !== WITC_MARKER_DATA_BYTES + 2) {
    return markerAppears
      ? malformed('MARKER_LENGTH', 'WITC marker script must be exactly 42 bytes')
      : { kind: 'not_protocol' };
  }

  const data = script.subarray(2);
  if (!data.subarray(0, 4).equals(WITC_MAGIC)) return { kind: 'not_protocol' };
  const version = data[4] ?? 0;
  const networkByte = data[5] ?? 0xff;
  const opcodeByte = data[6] ?? 0;
  const participantCount = data[7] ?? 0;
  const contextHash = data.subarray(8, 40).toString('hex');
  const dataHex = data.toString('hex');

  if (version !== WITC_VERSION) {
    return {
      kind: 'unknown_version',
      version,
      networkByte,
      opcodeByte,
      participantCount,
      contextHash,
      dataHex,
    };
  }
  if (networkByte < 0 || networkByte > 3) {
    return malformed('UNKNOWN_NETWORK', `Unknown WITC network byte ${networkByte}`, data);
  }
  if (opcodeByte !== WITC_OPCODE_CIRCLE) {
    return malformed('UNKNOWN_OPCODE', `WITC supports only CIRCLE opcode 1`, data);
  }
  if (participantCount < 2 || participantCount > 16) {
    return malformed(
      'INVALID_PARTICIPANT_COUNT',
      'WITC participant count must be between 2 and 16',
      data,
    );
  }
  if (/^0{64}$/.test(contextHash)) {
    return malformed('ZERO_CONTEXT_HASH', 'WITC CIRCLE context hash must not be zero', data);
  }

  const envelope: WitnessEnvelope = {
    version: WITC_VERSION,
    network: networkByte,
    opcode: WITC_OPCODE_CIRCLE,
    participantCount,
    contextHash,
    dataHex,
    scriptHex: normalized,
  };
  return { kind: 'parsed', envelope };
}

export function encodeWitnessData(
  network: WitnessNetwork,
  participantCount: number,
  contextHash: string,
): Buffer {
  if (network < WitnessNetwork.MAINNET || network > WitnessNetwork.REGTEST) {
    throw new Error('Invalid WITC network byte');
  }
  if (!Number.isInteger(participantCount) || participantCount < 2 || participantCount > 16) {
    throw new Error('WITC participant count must be between 2 and 16');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(contextHash) || /^0{64}$/i.test(contextHash)) {
    throw new Error('WITC context hash must be 32 nonzero bytes');
  }
  return Buffer.concat([
    WITC_MAGIC,
    Buffer.from([WITC_VERSION, network, WITC_OPCODE_CIRCLE, participantCount]),
    Buffer.from(contextHash, 'hex'),
  ]);
}

export function encodeWitnessScript(
  network: WitnessNetwork,
  participantCount: number,
  contextHash: string,
): string {
  const data = encodeWitnessData(network, participantCount, contextHash);
  return Buffer.concat([Buffer.from([0x6a, WITC_MARKER_DATA_BYTES]), data]).toString('hex');
}
