import { Injectable } from '@nestjs/common';
import { WITC_MAX_MONEY_SATS, WITC_MIN_SHARD_SATS, WITC_SEQUENCE } from './constants';
import {
  compareOutpoints,
  deriveLineageId,
  isP2trScript,
  usesAllowedTaprootKeyPathSighash,
} from './bitcoin';
import { parseWitnessScript } from './codec';
import {
  BitcoinInput,
  BitcoinTransaction,
  CircleMemberTransition,
  ClosureTransition,
  EvaluationCode,
  EvaluationContext,
  EvaluationResult,
  outpointKey,
} from './types';

@Injectable()
export class WitnessStateEngine {
  async evaluate(
    transaction: BitcoinTransaction,
    context: EvaluationContext,
  ): Promise<EvaluationResult> {
    const closures = await this.findClosures(transaction, context, 'ordinary_spend');
    const candidates = transaction.outputs
      .map((output, index) => ({ index, parsed: parseWitnessScript(output.scriptPubKeyHex) }))
      .filter(({ parsed }) => parsed.kind !== 'not_protocol');

    if (candidates.length === 0) return { classification: 'none', closures };
    if (candidates.length > 1) {
      return this.invalid(
        'MULTIPLE_PROTOCOL_OUTPUTS',
        'A WITC transaction must contain exactly one protocol marker',
        closures,
      );
    }
    const candidate = candidates[0]!;
    if (candidate.index !== 0) {
      return this.invalid(
        'PROTOCOL_OUTPUT_NOT_VOUT_ZERO',
        'The WITC marker must be output zero',
        closures,
      );
    }
    const parsed = candidate.parsed;
    if (parsed.kind === 'malformed') {
      return this.invalid(parsed.code, parsed.detail, closures, parsed.dataHex);
    }
    if (parsed.kind === 'unknown_version') {
      return {
        classification: 'observed',
        version: parsed.version,
        networkByte: parsed.networkByte,
        opcodeByte: parsed.opcodeByte,
        participantCount: parsed.participantCount,
        contextHash: parsed.contextHash,
        dataHex: parsed.dataHex,
        closures: closures.map((closure) => ({
          ...closure,
          reason: 'unknown_version_spend',
        })),
      };
    }
    if (parsed.kind !== 'parsed') return { classification: 'none', closures };
    const envelope = parsed.envelope;
    const invalidClosures = closures.map((closure) => ({
      ...closure,
      reason: 'invalid_protocol_spend' as const,
    }));

    if (envelope.network !== context.network) {
      return this.invalid(
        'NETWORK_MISMATCH',
        `Marker network ${envelope.network} does not match indexer network ${context.network}`,
        invalidClosures,
        envelope.dataHex,
        envelope,
      );
    }
    if (transaction.version !== 2) {
      return this.invalid(
        'TRANSACTION_VERSION',
        'WITC v1 requires transaction version 2',
        invalidClosures,
        envelope.dataHex,
        envelope,
      );
    }
    if (transaction.locktime !== 0) {
      return this.invalid(
        'LOCKTIME_MISMATCH',
        'WITC v1 requires locktime 0',
        invalidClosures,
        envelope.dataHex,
        envelope,
      );
    }
    if (transaction.inputs.length !== envelope.participantCount) {
      return this.invalid(
        'PARTICIPANT_COUNT_MISMATCH',
        'Marker participant count must equal input count',
        invalidClosures,
        envelope.dataHex,
        envelope,
      );
    }
    if (transaction.outputs.length !== transaction.inputs.length + 1) {
      return this.invalid(
        'OUTPUT_COUNT_MISMATCH',
        'WITC requires one marker plus one successor per input',
        invalidClosures,
        envelope.dataHex,
        envelope,
      );
    }
    if (transaction.outputs[0]?.valueSats !== 0n) {
      return this.invalid(
        'MARKER_VALUE',
        'WITC marker output must contain zero sats',
        invalidClosures,
        envelope.dataHex,
        envelope,
      );
    }

    const normalizedInputs: Array<
      Required<Pick<BitcoinInput, 'txid' | 'vout'>> & {
        prevout: NonNullable<BitcoinInput['prevout']>;
      }
    > = [];
    const scripts = new Set<string>();
    const outpoints = new Set<string>();
    let totalInputs = 0n;
    for (const input of transaction.inputs) {
      if (input.coinbase || !input.txid || input.vout === undefined) {
        return this.invalid(
          'COINBASE_INPUT',
          'WITC inputs must reference ordinary transaction outputs',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      if (input.sequence !== WITC_SEQUENCE) {
        return this.invalid(
          'SEQUENCE_MISMATCH',
          `Every WITC input sequence must be ${WITC_SEQUENCE}`,
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      if (!input.prevout) {
        return this.invalid(
          'MISSING_PREVOUT',
          'Every WITC input requires a resolved prevout',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      if (input.prevout.confirmed === false || input.prevout.blockHeight === undefined) {
        return this.invalid(
          'UNCONFIRMED_PREVOUT',
          'Every WITC prevout must be confirmed with a known block height',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      if (input.prevout.blockHeight >= context.blockHeight) {
        return this.invalid(
          'SAME_BLOCK_PREVOUT',
          'WITC prevouts must be confirmed in an earlier block',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      if (!isP2trScript(input.prevout.scriptPubKeyHex)) {
        return this.invalid(
          'NON_P2TR_PREVOUT',
          'Every WITC prevout must be native P2TR',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      if (!usesAllowedTaprootKeyPathSighash(input)) {
        return this.invalid(
          'INVALID_SIGHASH',
          'WITC accepts one key-path SIGHASH_DEFAULT or SIGHASH_ALL signature only',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      const outpoint = outpointKey({ txid: input.txid, vout: input.vout });
      if (outpoints.has(outpoint)) {
        return this.invalid(
          'DUPLICATE_OUTPOINT',
          'A WITC input outpoint may appear only once',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      outpoints.add(outpoint);
      const normalizedScript = input.prevout.scriptPubKeyHex.toLowerCase();
      if (scripts.has(normalizedScript)) {
        return this.invalid(
          'DUPLICATE_SCRIPT',
          'Participant P2TR scripts must be distinct',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      scripts.add(normalizedScript);
      if (input.prevout.valueSats < 0n || input.prevout.valueSats > WITC_MAX_MONEY_SATS) {
        return this.invalid(
          'VALUE_RANGE',
          'Input value is outside the Bitcoin money range',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      totalInputs += input.prevout.valueSats;
      if (totalInputs > WITC_MAX_MONEY_SATS) {
        return this.invalid(
          'VALUE_RANGE',
          'Total input value is outside the Bitcoin money range',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      normalizedInputs.push({
        txid: input.txid.toLowerCase(),
        vout: input.vout,
        prevout: input.prevout,
      });
    }

    const expected = [...normalizedInputs].sort(compareOutpoints);
    if (
      expected.some((input, index) => outpointKey(input) !== outpointKey(normalizedInputs[index]!))
    ) {
      return this.invalid(
        'INPUT_ORDER',
        'WITC inputs must be sorted by display txid bytes and then vout',
        invalidClosures,
        envelope.dataHex,
        envelope,
      );
    }

    let totalOutputs = 0n;
    for (const output of transaction.outputs) {
      if (output.valueSats < 0n || output.valueSats > WITC_MAX_MONEY_SATS) {
        return this.invalid(
          'VALUE_RANGE',
          'Output value is outside the Bitcoin money range',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      totalOutputs += output.valueSats;
      if (totalOutputs > WITC_MAX_MONEY_SATS) {
        return this.invalid(
          'VALUE_RANGE',
          'Total output value is outside the Bitcoin money range',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
    }
    const feeSats = totalInputs - totalOutputs;
    if (feeSats < 0n) {
      return this.invalid(
        'NEGATIVE_FEE',
        'WITC output value exceeds input value',
        invalidClosures,
        envelope.dataHex,
        envelope,
      );
    }

    const participantCount = BigInt(normalizedInputs.length);
    const quotient = feeSats / participantCount;
    const remainder = feeSats % participantCount;
    const members: CircleMemberTransition[] = [];
    const usedLineages = new Set<string>();
    for (let slot = 0; slot < normalizedInputs.length; slot += 1) {
      const input = normalizedInputs[slot]!;
      const output = transaction.outputs[slot + 1]!;
      const existingShard = await context.lookup.shardByOutpoint(input);
      if (existingShard && existingShard.status !== 'active') {
        return this.invalid(
          'NON_CURRENT_SHARD',
          'A known historical shard is not a current active lineage shard',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      const lineageId = existingShard?.lineageId ?? deriveLineageId(input);
      if (usedLineages.has(lineageId)) {
        return this.invalid(
          'DUPLICATE_LINEAGE',
          'A lineage may participate only once in a Circle',
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      usedLineages.add(lineageId);
      if (existingShard) {
        const lineage = await context.lookup.lineageById(lineageId);
        if (
          !lineage ||
          lineage.status !== 'active' ||
          lineage.currentTxid !== input.txid ||
          lineage.currentVout !== input.vout
        ) {
          return this.invalid(
            'LINEAGE_STATE_MISMATCH',
            'Shard and lineage current-state records disagree',
            invalidClosures,
            envelope.dataHex,
            envelope,
          );
        }
      }
      if (output.scriptPubKeyHex.toLowerCase() !== input.prevout.scriptPubKeyHex.toLowerCase()) {
        return this.invalid(
          'SUCCESSOR_SCRIPT_MISMATCH',
          `Output ${slot + 1} must preserve its input P2TR script`,
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      const feeShareSats = quotient + (BigInt(slot) < remainder ? 1n : 0n);
      const expectedValue = input.prevout.valueSats - feeShareSats;
      if (output.valueSats !== expectedValue) {
        return this.invalid(
          'SUCCESSOR_VALUE_MISMATCH',
          `Output ${slot + 1} does not pay its deterministic equal fee share`,
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      if (output.valueSats < WITC_MIN_SHARD_SATS) {
        return this.invalid(
          'SUCCESSOR_BELOW_MINIMUM',
          `Output ${slot + 1} must contain at least ${WITC_MIN_SHARD_SATS} sats`,
          invalidClosures,
          envelope.dataHex,
          envelope,
        );
      }
      members.push({
        slot,
        inputVin: slot,
        outputVout: slot + 1,
        lineageId,
        fresh: existingShard === null,
        previousCircleTxid: existingShard?.createdCircleTxid ?? null,
        input,
        output,
        feeShareSats,
      });
    }

    return {
      classification: 'valid',
      envelope,
      transition: { kind: 'circle', txid: transaction.txid, envelope, feeSats, members },
    };
  }

  private async findClosures(
    transaction: BitcoinTransaction,
    context: EvaluationContext,
    reason: ClosureTransition['reason'],
  ): Promise<ClosureTransition[]> {
    const closures = new Map<string, ClosureTransition>();
    for (let vin = 0; vin < transaction.inputs.length; vin += 1) {
      const input = transaction.inputs[vin];
      if (!input?.txid || input.vout === undefined) continue;
      const shard = await context.lookup.shardByOutpoint({ txid: input.txid, vout: input.vout });
      if (!shard || shard.status !== 'active') continue;
      closures.set(shard.lineageId, {
        lineageId: shard.lineageId,
        shard,
        spendingTxid: transaction.txid,
        spendingVin: vin,
        reason,
      });
    }
    return [...closures.values()].sort((a, b) =>
      a.lineageId < b.lineageId ? -1 : a.lineageId > b.lineageId ? 1 : 0,
    );
  }

  private invalid(
    code: EvaluationCode,
    detail: string,
    closures: ClosureTransition[],
    dataHex?: string,
    envelope?: Extract<ReturnType<typeof parseWitnessScript>, { kind: 'parsed' }>['envelope'],
  ): EvaluationResult {
    return {
      classification: 'invalid',
      code,
      detail,
      ...(dataHex ? { dataHex } : {}),
      ...(envelope ? { envelope } : {}),
      closures,
    };
  }
}
