import { createHash } from 'node:crypto';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const MAX_MONEY_SATS = 2_100_000_000_000_000n;

export interface CanonicalStateLineage {
  lineageId: string;
  genesisOutpoint: string;
  currentOutpoint: string | null;
  status: 'active' | 'closed';
  firstHeight: number;
  lastHeight: number;
  circleCount: number;
  closedByTxid: string | null;
}

export interface CanonicalStateShard {
  outpoint: string;
  lineageId: string;
  scriptPubKey: string;
  valueSats: string;
  createdByCircle: string;
  previousOutpoint: string;
  createdHeight: number;
  spentByTxid: string | null;
  spentHeight: number | null;
}

export interface CanonicalStateCircleMember {
  slot: number;
  lineageId: string;
  inputOutpoint: string;
  outputOutpoint: string;
  inputValueSats: string;
  outputValueSats: string;
  feeShareSats: string;
  wasExistingLineage: boolean;
}

export interface CanonicalStateCircle {
  txid: string;
  wtxid: string;
  contextHash: string;
  participantCount: number;
  feeSats: string;
  blockHeight: number;
  blockHash: string;
  transactionIndex: number;
  members: CanonicalStateCircleMember[];
}

export interface CanonicalStateEdge {
  fromCircle: string;
  toCircle: string;
  lineageId: string;
  viaOutpoint: string;
}

export interface CanonicalWitnessStateSnapshot {
  protocol: 'witc';
  version: 1;
  revision: number;
  lineages: CanonicalStateLineage[];
  shards: CanonicalStateShard[];
  circles: CanonicalStateCircle[];
  edges: CanonicalStateEdge[];
}

export interface StateRootReader {
  query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error('State-root query did not return rows');
  return value as Array<Record<string, unknown>>;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`State-root field ${field} is not a string`);
  return value;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : stringValue(value, field);
}

function numberValue(value: unknown, field: string): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`State-root field ${field} is not a nonnegative safe integer`);
  }
  return result;
}

function booleanValue(value: unknown, field: string): boolean {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new Error(`State-root field ${field} is not boolean`);
}

function outpoint(txid: unknown, vout: unknown, field: string): string {
  const index = numberValue(vout, `${field}.vout`);
  if (index > 0xffff_ffff) throw new Error(`State-root field ${field}.vout exceeds uint32`);
  return `${stringValue(txid, `${field}.txid`)}:${index}`;
}

function compareOrdinal(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Invalid Unicode in state root');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('Invalid Unicode in state root');
    }
  }
}

function canonicalize(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Nonfinite number in state root');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => {
      assertValidUnicode(key);
      const child = value[key];
      if (child === undefined) throw new Error('Undefined value in state root');
      return `${JSON.stringify(key)}:${canonicalize(child)}`;
    })
    .join(',')}}`;
}

function validateHex64(value: string | null, field: string): void {
  if (value !== null && !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`State-root field ${field} is not canonical 32-byte hex`);
  }
}

function validateOutpoint(value: string | null, field: string): void {
  if (value === null) return;
  const match = /^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/.exec(value);
  const vout = match ? Number(match[2]) : -1;
  if (!match || !Number.isSafeInteger(vout) || vout < 0 || vout > 0xffff_ffff) {
    throw new Error(`State-root field ${field} is not a canonical uint32 outpoint`);
  }
}

function validateSats(value: string, field: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > MAX_MONEY_SATS) {
    throw new Error(`State-root field ${field} is outside Bitcoin money range`);
  }
}

function validateSnapshot(snapshot: CanonicalWitnessStateSnapshot): void {
  if (snapshot.protocol !== 'witc' || snapshot.version !== 1) {
    throw new Error('Unsupported canonical state snapshot');
  }
  numberValue(snapshot.revision, 'revision');
  for (const lineage of snapshot.lineages) {
    validateHex64(lineage.lineageId, 'lineage.lineageId');
    validateOutpoint(lineage.genesisOutpoint, 'lineage.genesisOutpoint');
    validateOutpoint(lineage.currentOutpoint, 'lineage.currentOutpoint');
    if (lineage.status !== 'active' && lineage.status !== 'closed') {
      throw new Error('State-root lineage status is invalid');
    }
    numberValue(lineage.firstHeight, 'lineage.firstHeight');
    numberValue(lineage.lastHeight, 'lineage.lastHeight');
    if (numberValue(lineage.circleCount, 'lineage.circleCount') < 1) {
      throw new Error('State-root lineage circleCount must be positive');
    }
    validateHex64(lineage.closedByTxid, 'lineage.closedByTxid');
  }
  for (const shard of snapshot.shards) {
    validateOutpoint(shard.outpoint, 'shard.outpoint');
    validateHex64(shard.lineageId, 'shard.lineageId');
    if (!/^5120[0-9a-f]{64}$/.test(shard.scriptPubKey)) {
      throw new Error('State-root shard script is not canonical P2TR hex');
    }
    validateSats(shard.valueSats, 'shard.valueSats');
    validateHex64(shard.createdByCircle, 'shard.createdByCircle');
    validateOutpoint(shard.previousOutpoint, 'shard.previousOutpoint');
    numberValue(shard.createdHeight, 'shard.createdHeight');
    validateHex64(shard.spentByTxid, 'shard.spentByTxid');
    if (shard.spentHeight !== null) numberValue(shard.spentHeight, 'shard.spentHeight');
  }
  for (const circle of snapshot.circles) {
    validateHex64(circle.txid, 'circle.txid');
    validateHex64(circle.wtxid, 'circle.wtxid');
    validateHex64(circle.contextHash, 'circle.contextHash');
    if (
      !Number.isInteger(circle.participantCount) ||
      circle.participantCount < 2 ||
      circle.participantCount > 16 ||
      circle.members.length !== circle.participantCount
    ) {
      throw new Error('State-root Circle participant count is invalid');
    }
    validateSats(circle.feeSats, 'circle.feeSats');
    numberValue(circle.blockHeight, 'circle.blockHeight');
    validateHex64(circle.blockHash, 'circle.blockHash');
    numberValue(circle.transactionIndex, 'circle.transactionIndex');
    for (const member of circle.members) {
      if (!Number.isInteger(member.slot) || member.slot < 0 || member.slot > 15) {
        throw new Error('State-root Circle member slot is invalid');
      }
      validateHex64(member.lineageId, 'member.lineageId');
      validateOutpoint(member.inputOutpoint, 'member.inputOutpoint');
      validateOutpoint(member.outputOutpoint, 'member.outputOutpoint');
      validateSats(member.inputValueSats, 'member.inputValueSats');
      validateSats(member.outputValueSats, 'member.outputValueSats');
      validateSats(member.feeShareSats, 'member.feeShareSats');
      if (typeof member.wasExistingLineage !== 'boolean') {
        throw new Error('State-root Circle lineage flag is not boolean');
      }
    }
  }
  for (const edge of snapshot.edges) {
    validateHex64(edge.fromCircle, 'edge.fromCircle');
    validateHex64(edge.toCircle, 'edge.toCircle');
    validateHex64(edge.lineageId, 'edge.lineageId');
    validateOutpoint(edge.viaOutpoint, 'edge.viaOutpoint');
  }
}

function sortedSnapshot(snapshot: CanonicalWitnessStateSnapshot): CanonicalWitnessStateSnapshot {
  return {
    ...snapshot,
    lineages: [...snapshot.lineages].sort((a, b) => compareOrdinal(a.lineageId, b.lineageId)),
    shards: [...snapshot.shards].sort((a, b) => compareOrdinal(a.outpoint, b.outpoint)),
    circles: [...snapshot.circles]
      .map((circle) => ({
        ...circle,
        members: [...circle.members].sort((a, b) => a.slot - b.slot),
      }))
      .sort(
        (a, b) =>
          a.blockHeight - b.blockHeight ||
          a.transactionIndex - b.transactionIndex ||
          compareOrdinal(a.txid, b.txid),
      ),
    edges: [...snapshot.edges].sort(
      (a, b) => compareOrdinal(a.toCircle, b.toCircle) || compareOrdinal(a.lineageId, b.lineageId),
    ),
  };
}

export function canonicalStateRoot(snapshot: CanonicalWitnessStateSnapshot): string {
  validateSnapshot(snapshot);
  const canonical = canonicalize(sortedSnapshot(snapshot) as unknown as JsonValue);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export const EMPTY_WITNESS_STATE: CanonicalWitnessStateSnapshot = {
  protocol: 'witc',
  version: 1,
  revision: 0,
  lineages: [],
  shards: [],
  circles: [],
  edges: [],
};

export const EMPTY_STATE_ROOT = canonicalStateRoot(EMPTY_WITNESS_STATE);

export async function readCanonicalWitnessState(
  reader: StateRootReader,
): Promise<CanonicalWitnessStateSnapshot> {
  const [revisionRows, circleRows, memberRows, lineageRows, shardRows, edgeRows] =
    await Promise.all([
      reader.query(`SELECT
      (SELECT COUNT(*) FROM wc_circles WHERE canonical = TRUE) +
      (SELECT COUNT(DISTINCT spending_txid) FROM wc_lineage_closures WHERE canonical = TRUE)
        AS revision`),
      reader.query(`SELECT c.circle_txid AS txid, t.wtxid, c.context_hash AS contextHash,
      c.participant_count AS participantCount, c.fee_sats AS feeSats,
      c.block_height AS blockHeight, c.block_hash AS blockHash,
      c.tx_position AS transactionIndex
      FROM wc_circles c JOIN wc_transactions t ON t.txid = c.circle_txid
      WHERE c.canonical = TRUE`),
      reader.query(`SELECT m.circle_txid AS txid, m.slot, m.lineage_id AS lineageId,
      m.input_txid AS inputTxid, m.input_vout AS inputVout,
      m.input_value_sats AS inputValueSats, m.output_vout AS outputVout,
      m.output_value_sats AS outputValueSats, m.fee_share_sats AS feeShareSats, m.fresh
      FROM wc_circle_members m JOIN wc_circles c ON c.circle_txid = m.circle_txid
      WHERE c.canonical = TRUE`),
      reader.query(`SELECT lineage_id AS lineageId, genesis_txid AS genesisTxid,
      genesis_vout AS genesisVout, current_txid AS currentTxid, current_vout AS currentVout,
      status, first_height AS firstHeight, last_height AS lastHeight,
      circle_count AS circleCount, closed_by_txid AS closedByTxid FROM wc_lineages`),
      reader.query(`SELECT s.txid, s.vout, s.lineage_id AS lineageId, s.value_sats AS valueSats,
      s.script_hex AS scriptPubKey, s.created_circle_txid AS createdByCircle,
      s.created_height AS createdHeight,
      COALESCE(s.previous_txid, m.input_txid) AS previousTxid,
      COALESCE(s.previous_vout, m.input_vout) AS previousVout,
      s.spent_by_txid AS spentByTxid, s.spent_height AS spentHeight
      FROM wc_shards s LEFT JOIN wc_circle_members m
        ON m.circle_txid = s.created_circle_txid AND m.output_vout = s.vout
          AND m.lineage_id = s.lineage_id`),
      reader.query(`SELECT from_circle_txid AS fromCircle, to_circle_txid AS toCircle,
      lineage_id AS lineageId, via_txid AS viaTxid, via_vout AS viaVout
      FROM wc_circle_edges WHERE canonical = TRUE`),
    ]);

  const membersByCircle = new Map<string, CanonicalStateCircleMember[]>();
  for (const row of rows(memberRows)) {
    const txid = stringValue(row.txid, 'member.txid');
    const members = membersByCircle.get(txid) ?? [];
    members.push({
      slot: numberValue(row.slot, 'member.slot'),
      lineageId: stringValue(row.lineageId, 'member.lineageId'),
      inputOutpoint: outpoint(row.inputTxid, row.inputVout, 'member.input'),
      outputOutpoint: outpoint(txid, row.outputVout, 'member.output'),
      inputValueSats: stringValue(String(row.inputValueSats), 'member.inputValueSats'),
      outputValueSats: stringValue(String(row.outputValueSats), 'member.outputValueSats'),
      feeShareSats: stringValue(String(row.feeShareSats), 'member.feeShareSats'),
      wasExistingLineage: !booleanValue(row.fresh, 'member.fresh'),
    });
    membersByCircle.set(txid, members);
  }

  const revisionRow = rows(revisionRows)[0];
  if (!revisionRow) throw new Error('State-root revision query returned no row');
  return {
    protocol: 'witc',
    version: 1,
    revision: numberValue(revisionRow.revision, 'revision'),
    lineages: rows(lineageRows).map((row) => {
      const status = stringValue(row.status, 'lineage.status');
      if (status !== 'active' && status !== 'closed') throw new Error('Invalid lineage status');
      const currentTxid = nullableString(row.currentTxid, 'lineage.currentTxid');
      const currentVout =
        row.currentVout === null ? null : numberValue(row.currentVout, 'lineage.currentVout');
      if ((currentTxid === null) !== (currentVout === null))
        throw new Error('Partial current outpoint');
      return {
        lineageId: stringValue(row.lineageId, 'lineage.lineageId'),
        genesisOutpoint: outpoint(row.genesisTxid, row.genesisVout, 'lineage.genesis'),
        currentOutpoint:
          currentTxid === null ? null : outpoint(currentTxid, currentVout, 'lineage.current'),
        status,
        firstHeight: numberValue(row.firstHeight, 'lineage.firstHeight'),
        lastHeight: numberValue(row.lastHeight, 'lineage.lastHeight'),
        circleCount: numberValue(row.circleCount, 'lineage.circleCount'),
        closedByTxid: nullableString(row.closedByTxid, 'lineage.closedByTxid'),
      };
    }),
    shards: rows(shardRows).map((row) => ({
      outpoint: outpoint(row.txid, row.vout, 'shard.outpoint'),
      lineageId: stringValue(row.lineageId, 'shard.lineageId'),
      scriptPubKey: stringValue(row.scriptPubKey, 'shard.scriptPubKey'),
      valueSats: String(row.valueSats),
      createdByCircle: stringValue(row.createdByCircle, 'shard.createdByCircle'),
      previousOutpoint: outpoint(row.previousTxid, row.previousVout, 'shard.previous'),
      createdHeight: numberValue(row.createdHeight, 'shard.createdHeight'),
      spentByTxid: nullableString(row.spentByTxid, 'shard.spentByTxid'),
      spentHeight:
        row.spentHeight === null ? null : numberValue(row.spentHeight, 'shard.spentHeight'),
    })),
    circles: rows(circleRows).map((row) => {
      const txid = stringValue(row.txid, 'circle.txid');
      return {
        txid,
        wtxid: stringValue(row.wtxid, 'circle.wtxid'),
        contextHash: stringValue(row.contextHash, 'circle.contextHash'),
        participantCount: numberValue(row.participantCount, 'circle.participantCount'),
        feeSats: String(row.feeSats),
        blockHeight: numberValue(row.blockHeight, 'circle.blockHeight'),
        blockHash: stringValue(row.blockHash, 'circle.blockHash'),
        transactionIndex: numberValue(row.transactionIndex, 'circle.transactionIndex'),
        members: membersByCircle.get(txid) ?? [],
      };
    }),
    edges: rows(edgeRows).map((row) => ({
      fromCircle: stringValue(row.fromCircle, 'edge.fromCircle'),
      toCircle: stringValue(row.toCircle, 'edge.toCircle'),
      lineageId: stringValue(row.lineageId, 'edge.lineageId'),
      viaOutpoint: outpoint(row.viaTxid, row.viaVout, 'edge.via'),
    })),
  };
}

export async function computeCanonicalStateRoot(reader: StateRootReader): Promise<string> {
  return canonicalStateRoot(await readCanonicalWitnessState(reader));
}
