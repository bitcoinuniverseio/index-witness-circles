import {
  WitnessNetwork,
  encodeWitnessData,
  encodeWitnessScript,
  parseWitnessScript,
} from '../src/protocol';
import { CONTEXT_HASH } from './fixtures';

describe('WITC marker codec', () => {
  it('encodes the exact 40-byte payload and 42-byte script', () => {
    const data = encodeWitnessData(WitnessNetwork.SIGNET, 8, CONTEXT_HASH);
    const script = encodeWitnessScript(WitnessNetwork.SIGNET, 8, CONTEXT_HASH);
    expect(data).toHaveLength(40);
    expect(Buffer.from(script, 'hex')).toHaveLength(42);
    expect(script.startsWith('6a285749544301020108')).toBe(true);
  });

  it('round trips a canonical marker', () => {
    const script = encodeWitnessScript(WitnessNetwork.REGTEST, 2, CONTEXT_HASH);
    expect(parseWitnessScript(script)).toEqual({
      kind: 'parsed',
      envelope: {
        version: 1,
        network: WitnessNetwork.REGTEST,
        opcode: 1,
        participantCount: 2,
        contextHash: CONTEXT_HASH,
        dataHex: script.slice(4),
        scriptHex: script,
      },
    });
  });

  it('ignores unrelated scripts and OP_RETURN values', () => {
    expect(parseWitnessScript('5120' + '00'.repeat(32))).toEqual({ kind: 'not_protocol' });
    expect(parseWitnessScript('6a046e6f7065')).toEqual({ kind: 'not_protocol' });
    expect(parseWitnessScript('xyz')).toEqual({ kind: 'not_protocol' });
  });

  it('rejects PUSHDATA1 and trailing bytes when WITC magic appears', () => {
    const data = encodeWitnessData(WitnessNetwork.REGTEST, 2, CONTEXT_HASH).toString('hex');
    expect(parseWitnessScript(`6a4c28${data}`)).toMatchObject({
      kind: 'malformed',
      code: 'NON_CANONICAL_OP_RETURN',
    });
    expect(
      parseWitnessScript(`${encodeWitnessScript(WitnessNetwork.REGTEST, 2, CONTEXT_HASH)}00`),
    ).toMatchObject({
      kind: 'malformed',
      code: 'MARKER_LENGTH',
    });
  });

  it('observes a future version without interpreting it', () => {
    const script = Buffer.from(encodeWitnessScript(WitnessNetwork.REGTEST, 2, CONTEXT_HASH), 'hex');
    script[6] = 2;
    expect(parseWitnessScript(script.toString('hex'))).toMatchObject({
      kind: 'unknown_version',
      version: 2,
      participantCount: 2,
    });
  });

  it.each([
    [7, 255, 'UNKNOWN_NETWORK'],
    [8, 2, 'UNKNOWN_OPCODE'],
    [9, 1, 'INVALID_PARTICIPANT_COUNT'],
  ])('rejects invalid header byte at script index %s', (scriptIndex, value, code) => {
    const script = Buffer.from(encodeWitnessScript(WitnessNetwork.REGTEST, 2, CONTEXT_HASH), 'hex');
    script[scriptIndex] = value;
    expect(parseWitnessScript(script.toString('hex'))).toMatchObject({ kind: 'malformed', code });
  });

  it('rejects a zero context and all invalid encoder arguments', () => {
    const script = Buffer.from(encodeWitnessScript(WitnessNetwork.REGTEST, 2, CONTEXT_HASH), 'hex');
    script.fill(0, 10, 42);
    expect(parseWitnessScript(script.toString('hex'))).toMatchObject({
      kind: 'malformed',
      code: 'ZERO_CONTEXT_HASH',
    });
    expect(() => encodeWitnessScript(9 as WitnessNetwork, 2, CONTEXT_HASH)).toThrow();
    expect(() => encodeWitnessScript(WitnessNetwork.REGTEST, 1, CONTEXT_HASH)).toThrow();
    expect(() => encodeWitnessScript(WitnessNetwork.REGTEST, 2, '00'.repeat(32))).toThrow();
  });

  it('never throws while scanning arbitrary script bytes', () => {
    let state = 0x9e37_79b9;
    for (let iteration = 0; iteration < 5_000; iteration += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const length = Math.abs(state) % 128;
      const bytes = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) | 0;
        bytes[index] = state & 0xff;
      }
      expect(() => parseWitnessScript(bytes.toString('hex'))).not.toThrow();
    }
  });
});
