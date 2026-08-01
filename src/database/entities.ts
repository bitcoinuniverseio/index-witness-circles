import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintTransformer } from './bigint.transformer';

@Entity('wc_blocks')
@Index('idx_wc_blocks_canonical_height', ['height', 'canonical'])
export class BlockEntity {
  @PrimaryColumn({ type: 'char', length: 64 }) hash: string;
  @Index() @Column({ type: 'int', unsigned: true }) height: number;
  @Column({ name: 'previous_hash', type: 'char', length: 64, nullable: true }) previousHash:
    string | null;
  @Column({ type: 'bigint', unsigned: true, transformer: bigintTransformer }) time: bigint;
  @Column({ name: 'median_time', type: 'bigint', unsigned: true, transformer: bigintTransformer })
  medianTime: bigint;
  @Column({ name: 'tx_count', type: 'int', unsigned: true }) txCount: number;
  @Column({ name: 'parser_version', type: 'varchar', length: 32 }) parserVersion: string;
  @Index() @Column({ type: 'boolean', default: true }) canonical: boolean;
  @CreateDateColumn({ name: 'processed_at', type: 'datetime', precision: 3 }) processedAt: Date;
}

@Entity('wc_transactions')
@Index('idx_wc_transactions_block_position', ['blockHash', 'position'])
export class TransactionEntity {
  @PrimaryColumn({ type: 'char', length: 64 }) txid: string;
  @Column({ type: 'char', length: 64, nullable: true }) wtxid: string | null;
  @Column({ name: 'block_hash', type: 'char', length: 64, nullable: true }) blockHash:
    string | null;
  @Index()
  @Column({ name: 'block_height', type: 'int', unsigned: true, nullable: true })
  blockHeight: number | null;
  @Column({ type: 'int', unsigned: true, nullable: true }) position: number | null;
  @Column({ type: 'int' }) version: number;
  @Column({ type: 'int', unsigned: true }) locktime: number;
  @Column({ type: 'int', unsigned: true, nullable: true }) size: number | null;
  @Column({ type: 'int', unsigned: true, nullable: true }) vsize: number | null;
  @Column({ type: 'int', unsigned: true, nullable: true }) weight: number | null;
  @Column({
    name: 'fee_sats',
    type: 'bigint',
    unsigned: true,
    nullable: true,
    transformer: bigintTransformer,
  })
  feeSats: bigint | null;
  @Column({ name: 'raw_hex', type: 'longtext', nullable: true }) rawHex: string | null;
  @Index() @Column({ type: 'boolean', default: true }) canonical: boolean;
  @Index() @Column({ type: 'boolean', default: true }) confirmed: boolean;
  @CreateDateColumn({ name: 'first_seen_at', type: 'datetime', precision: 3 }) firstSeenAt: Date;
}

@Entity('wc_transaction_inputs')
@Index('idx_wc_inputs_prevout', ['prevTxid', 'prevVout'])
export class TransactionInputEntity {
  @PrimaryColumn({ type: 'char', length: 64 }) txid: string;
  @PrimaryColumn({ type: 'smallint', unsigned: true }) vin: number;
  @Column({ name: 'prev_txid', type: 'char', length: 64, nullable: true }) prevTxid: string | null;
  @Column({ name: 'prev_vout', type: 'int', unsigned: true, nullable: true }) prevVout:
    number | null;
  @Column({ type: 'bigint', unsigned: true, transformer: bigintTransformer }) sequence: bigint;
  @Column({ type: 'longtext', nullable: true }) coinbase: string | null;
  @Column({ name: 'witness_json', type: 'json' }) witnessJson: string[];
  @Column({
    name: 'prev_value_sats',
    type: 'bigint',
    unsigned: true,
    nullable: true,
    transformer: bigintTransformer,
  })
  prevValueSats: bigint | null;
  @Column({ name: 'prev_script_hex', type: 'text', nullable: true }) prevScriptHex: string | null;
  @Column({ name: 'prev_script_hash', type: 'char', length: 64, nullable: true }) prevScriptHash:
    string | null;
  @Column({ name: 'prev_address', type: 'varchar', length: 128, nullable: true }) prevAddress:
    string | null;
  @Column({ name: 'prev_block_height', type: 'int', unsigned: true, nullable: true })
  prevBlockHeight: number | null;
}

@Entity('wc_transaction_outputs')
@Index('idx_wc_outputs_script_hash', ['scriptHash'])
@Index('idx_wc_outputs_address', ['address'])
@Index('idx_wc_outputs_spender', ['spentByTxid'])
export class TransactionOutputEntity {
  @PrimaryColumn({ type: 'char', length: 64 }) txid: string;
  @PrimaryColumn({ type: 'int', unsigned: true }) vout: number;
  @Column({ name: 'value_sats', type: 'bigint', unsigned: true, transformer: bigintTransformer })
  valueSats: bigint;
  @Column({ name: 'script_hex', type: 'text' }) scriptHex: string;
  @Column({ name: 'script_hash', type: 'char', length: 64 }) scriptHash: string;
  @Column({ name: 'script_type', type: 'varchar', length: 32, nullable: true }) scriptType:
    string | null;
  @Column({ type: 'varchar', length: 128, nullable: true }) address: string | null;
  @Column({ name: 'is_witc_marker', type: 'boolean', default: false }) isWitcMarker: boolean;
  @Column({ name: 'shard_lineage_id', type: 'char', length: 64, nullable: true })
  shardLineageId: string | null;
  @Column({ name: 'spent_by_txid', type: 'char', length: 64, nullable: true }) spentByTxid:
    string | null;
  @Column({ name: 'spent_by_vin', type: 'smallint', unsigned: true, nullable: true }) spentByVin:
    number | null;
  @Column({ name: 'spent_height', type: 'int', unsigned: true, nullable: true }) spentHeight:
    number | null;
}

@Entity('wc_circles')
@Index('idx_wc_circles_status_height', ['status', 'blockHeight', 'txPosition'])
@Index('idx_wc_circles_context_height', ['contextHash', 'blockHeight'])
@Check('chk_wc_circles_participants', 'participant_count BETWEEN 2 AND 16')
export class CircleEntity {
  @PrimaryColumn({ name: 'circle_txid', type: 'char', length: 64 }) circleTxid: string;
  @Column({ type: 'tinyint', unsigned: true }) version: number;
  @Column({ type: 'tinyint', unsigned: true }) network: number;
  @Column({ type: 'tinyint', unsigned: true }) opcode: number;
  @Column({ name: 'participant_count', type: 'tinyint', unsigned: true }) participantCount: number;
  @Column({ name: 'context_hash', type: 'char', length: 64 }) contextHash: string;
  @Column({ name: 'marker_hex', type: 'char', length: 84 }) markerHex: string;
  @Column({ name: 'fee_sats', type: 'bigint', unsigned: true, transformer: bigintTransformer })
  feeSats: bigint;
  @Column({ name: 'fresh_lineages', type: 'tinyint', unsigned: true }) freshLineages: number;
  @Index() @Column({ type: 'varchar', length: 16 }) status: string;
  @Column({ type: 'boolean', default: true }) canonical: boolean;
  @Column({ name: 'block_hash', type: 'char', length: 64 }) blockHash: string;
  @Column({ name: 'block_height', type: 'int', unsigned: true }) blockHeight: number;
  @Column({ name: 'tx_position', type: 'int', unsigned: true }) txPosition: number;
  @Column({ name: 'confirmed_at', type: 'datetime', precision: 3 }) confirmedAt: Date;
  @Column({ name: 'state_root_after', type: 'char', length: 64, nullable: true })
  stateRootAfter: string | null;
  @CreateDateColumn({ name: 'indexed_at', type: 'datetime', precision: 3 }) indexedAt: Date;
}

@Entity('wc_circle_members')
@Index('idx_wc_members_lineage_height', ['lineageId', 'blockHeight'])
@Index('idx_wc_members_input', ['inputTxid', 'inputVout'])
@Index('idx_wc_members_script_hash', ['scriptHash'])
export class CircleMemberEntity {
  @PrimaryColumn({ name: 'circle_txid', type: 'char', length: 64 }) circleTxid: string;
  @PrimaryColumn({ type: 'tinyint', unsigned: true }) slot: number;
  @Column({ name: 'lineage_id', type: 'char', length: 64 }) lineageId: string;
  @Column({ name: 'input_txid', type: 'char', length: 64 }) inputTxid: string;
  @Column({ name: 'input_vout', type: 'int', unsigned: true }) inputVout: number;
  @Column({
    name: 'input_value_sats',
    type: 'bigint',
    unsigned: true,
    transformer: bigintTransformer,
  })
  inputValueSats: bigint;
  @Column({ name: 'output_vout', type: 'int', unsigned: true }) outputVout: number;
  @Column({
    name: 'output_value_sats',
    type: 'bigint',
    unsigned: true,
    transformer: bigintTransformer,
  })
  outputValueSats: bigint;
  @Column({
    name: 'fee_share_sats',
    type: 'bigint',
    unsigned: true,
    transformer: bigintTransformer,
  })
  feeShareSats: bigint;
  @Column({ name: 'script_hash', type: 'char', length: 64 }) scriptHash: string;
  @Column({ type: 'varchar', length: 128, nullable: true }) address: string | null;
  @Column({ type: 'boolean' }) fresh: boolean;
  @Column({ name: 'previous_circle_txid', type: 'char', length: 64, nullable: true })
  previousCircleTxid: string | null;
  @Column({ name: 'block_height', type: 'int', unsigned: true }) blockHeight: number;
}

@Entity('wc_lineages')
@Index('uq_wc_lineages_current_outpoint', ['currentTxid', 'currentVout'], { unique: true })
@Index('idx_wc_lineages_status_height', ['status', 'lastHeight'])
@Index('idx_wc_lineages_script_hash', ['currentScriptHash'])
export class LineageEntity {
  @PrimaryColumn({ name: 'lineage_id', type: 'char', length: 64 }) lineageId: string;
  @Column({ name: 'genesis_txid', type: 'char', length: 64 }) genesisTxid: string;
  @Column({ name: 'genesis_vout', type: 'int', unsigned: true }) genesisVout: number;
  @Column({ name: 'current_txid', type: 'char', length: 64, nullable: true }) currentTxid:
    string | null;
  @Column({ name: 'current_vout', type: 'int', unsigned: true, nullable: true }) currentVout:
    number | null;
  @Column({
    name: 'current_value_sats',
    type: 'bigint',
    unsigned: true,
    nullable: true,
    transformer: bigintTransformer,
  })
  currentValueSats: bigint | null;
  @Column({ name: 'current_script_hash', type: 'char', length: 64, nullable: true })
  currentScriptHash: string | null;
  @Column({ name: 'current_address', type: 'varchar', length: 128, nullable: true })
  currentAddress: string | null;
  @Index() @Column({ type: 'varchar', length: 16 }) status: string;
  @Column({ name: 'first_height', type: 'int', unsigned: true }) firstHeight: number;
  @Column({ name: 'last_height', type: 'int', unsigned: true }) lastHeight: number;
  @Column({ name: 'circle_count', type: 'int', unsigned: true }) circleCount: number;
  @Column({ name: 'last_circle_txid', type: 'char', length: 64, nullable: true })
  lastCircleTxid: string | null;
  @Column({ name: 'closed_by_txid', type: 'char', length: 64, nullable: true })
  closedByTxid: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 }) updatedAt: Date;
}

@Entity('wc_shards')
@Index('idx_wc_shards_lineage_height', ['lineageId', 'createdHeight'])
@Index('idx_wc_shards_status_script', ['status', 'scriptHash'])
@Check('chk_wc_shards_minimum', 'value_sats >= 1000')
export class ShardEntity {
  @PrimaryColumn({ type: 'char', length: 64 }) txid: string;
  @PrimaryColumn({ type: 'int', unsigned: true }) vout: number;
  @Column({ name: 'lineage_id', type: 'char', length: 64 }) lineageId: string;
  @Column({ name: 'value_sats', type: 'bigint', unsigned: true, transformer: bigintTransformer })
  valueSats: bigint;
  @Column({ name: 'script_hex', type: 'text' }) scriptHex: string;
  @Column({ name: 'script_hash', type: 'char', length: 64 }) scriptHash: string;
  @Column({ type: 'varchar', length: 128, nullable: true }) address: string | null;
  @Index() @Column({ type: 'varchar', length: 16 }) status: string;
  @Column({ name: 'created_circle_txid', type: 'char', length: 64 }) createdCircleTxid: string;
  @Column({ name: 'created_height', type: 'int', unsigned: true }) createdHeight: number;
  @Column({ name: 'previous_txid', type: 'char', length: 64, nullable: true }) previousTxid:
    string | null;
  @Column({ name: 'previous_vout', type: 'int', unsigned: true, nullable: true }) previousVout:
    number | null;
  @Column({ name: 'spent_by_txid', type: 'char', length: 64, nullable: true }) spentByTxid:
    string | null;
  @Column({ name: 'spent_by_vin', type: 'smallint', unsigned: true, nullable: true }) spentByVin:
    number | null;
  @Column({ name: 'spent_height', type: 'int', unsigned: true, nullable: true }) spentHeight:
    number | null;
}

@Entity('wc_circle_edges')
@Index('idx_wc_edges_from', ['fromCircleTxid'])
@Index('idx_wc_edges_to', ['toCircleTxid'])
export class CircleEdgeEntity {
  @PrimaryColumn({ name: 'from_circle_txid', type: 'char', length: 64 }) fromCircleTxid: string;
  @PrimaryColumn({ name: 'to_circle_txid', type: 'char', length: 64 }) toCircleTxid: string;
  @PrimaryColumn({ name: 'lineage_id', type: 'char', length: 64 }) lineageId: string;
  @PrimaryColumn({ name: 'via_txid', type: 'char', length: 64 }) viaTxid: string;
  @PrimaryColumn({ name: 'via_vout', type: 'int', unsigned: true }) viaVout: number;
  @Column({ type: 'boolean', default: true }) canonical: boolean;
  @Column({ name: 'block_height', type: 'int', unsigned: true }) blockHeight: number;
}

@Entity('wc_lineage_closures')
@Index('idx_wc_closures_lineage_height', ['lineageId', 'blockHeight'])
export class LineageClosureEntity {
  @PrimaryColumn({ name: 'spending_txid', type: 'char', length: 64 }) spendingTxid: string;
  @PrimaryColumn({ name: 'lineage_id', type: 'char', length: 64 }) lineageId: string;
  @Column({ name: 'spending_vin', type: 'smallint', unsigned: true }) spendingVin: number;
  @Column({ name: 'shard_txid', type: 'char', length: 64 }) shardTxid: string;
  @Column({ name: 'shard_vout', type: 'int', unsigned: true }) shardVout: number;
  @Column({ type: 'varchar', length: 32 }) reason: string;
  @Column({ name: 'block_hash', type: 'char', length: 64 }) blockHash: string;
  @Column({ name: 'block_height', type: 'int', unsigned: true }) blockHeight: number;
  @Column({ type: 'boolean', default: true }) canonical: boolean;
  @CreateDateColumn({ name: 'observed_at', type: 'datetime', precision: 3 }) observedAt: Date;
}

@Entity('wc_mempool_transactions')
@Index('idx_wc_mempool_status_seen', ['status', 'lastSeenAt'])
export class MempoolTransactionEntity {
  @PrimaryColumn({ type: 'char', length: 64 }) txid: string;
  @Index() @Column({ type: 'varchar', length: 16 }) status: string;
  @Column({ name: 'raw_hex', type: 'longtext', nullable: true }) rawHex: string | null;
  @Column({ name: 'protocol_status', type: 'varchar', length: 16, nullable: true })
  protocolStatus: string | null;
  @Column({ name: 'protocol_code', type: 'varchar', length: 64, nullable: true }) protocolCode:
    string | null;
  @Column({ name: 'evaluated_tip_height', type: 'int', unsigned: true, nullable: true })
  evaluatedTipHeight: number | null;
  @Column({ name: 'evaluated_tip_hash', type: 'char', length: 64, nullable: true })
  evaluatedTipHash: string | null;
  @Column({ name: 'projection_json', type: 'json', nullable: true }) projectionJson: Record<
    string,
    unknown
  > | null;
  @Column({
    name: 'fee_sats',
    type: 'bigint',
    unsigned: true,
    nullable: true,
    transformer: bigintTransformer,
  })
  feeSats: bigint | null;
  @Column({ type: 'int', unsigned: true, nullable: true }) vsize: number | null;
  @CreateDateColumn({ name: 'first_seen_at', type: 'datetime', precision: 3 }) firstSeenAt: Date;
  @UpdateDateColumn({ name: 'last_seen_at', type: 'datetime', precision: 3 }) lastSeenAt: Date;
}

@Entity('wc_mempool_inputs')
@Index('idx_wc_mempool_inputs_outpoint', ['prevTxid', 'prevVout'])
export class MempoolInputEntity {
  @PrimaryColumn({ type: 'char', length: 64 }) txid: string;
  @PrimaryColumn({ type: 'smallint', unsigned: true }) vin: number;
  @Column({ name: 'prev_txid', type: 'char', length: 64 }) prevTxid: string;
  @Column({ name: 'prev_vout', type: 'int', unsigned: true }) prevVout: number;
  @Column({ type: 'bigint', unsigned: true, transformer: bigintTransformer }) sequence: bigint;
}

@Entity('wc_mempool_replacements')
export class ReplacementEntity {
  @PrimaryColumn({ name: 'old_txid', type: 'char', length: 64 }) oldTxid: string;
  @PrimaryColumn({ name: 'new_txid', type: 'char', length: 64 }) newTxid: string;
  @Column({ type: 'varchar', length: 64, nullable: true }) reason: string | null;
  @CreateDateColumn({ name: 'observed_at', type: 'datetime', precision: 3 }) observedAt: Date;
}

@Entity('wc_mempool_conflicts')
@Index('idx_wc_conflicts_outpoint_status', ['prevTxid', 'prevVout', 'status'])
export class ConflictEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true }) id: string;
  @Column({ name: 'prev_txid', type: 'char', length: 64 }) prevTxid: string;
  @Column({ name: 'prev_vout', type: 'int', unsigned: true }) prevVout: number;
  @Column({ name: 'first_txid', type: 'char', length: 64 }) firstTxid: string;
  @Column({ name: 'second_txid', type: 'char', length: 64 }) secondTxid: string;
  @Column({ name: 'winner_txid', type: 'char', length: 64, nullable: true }) winnerTxid:
    string | null;
  @Column({ type: 'varchar', length: 16, default: 'open' }) status: string;
  @CreateDateColumn({ name: 'observed_at', type: 'datetime', precision: 3 }) observedAt: Date;
  @Column({ name: 'resolved_at', type: 'datetime', precision: 3, nullable: true })
  resolvedAt: Date | null;
}

@Entity('wc_invalid_events')
@Index('idx_wc_invalid_code_height', ['errorCode', 'blockHeight'])
export class InvalidEventEntity {
  @PrimaryColumn({ type: 'char', length: 64 }) txid: string;
  @Column({ type: 'varchar', length: 16 }) classification: string;
  @Column({ name: 'error_code', type: 'varchar', length: 64 }) errorCode: string;
  @Column({ type: 'text' }) detail: string;
  @Column({ name: 'data_hex', type: 'varchar', length: 80, nullable: true }) dataHex: string | null;
  @Column({ name: 'block_hash', type: 'char', length: 64, nullable: true }) blockHash:
    string | null;
  @Column({ name: 'block_height', type: 'int', unsigned: true, nullable: true }) blockHeight:
    number | null;
  @Column({ name: 'mempool_only', type: 'boolean', default: false }) mempoolOnly: boolean;
  @Column({ type: 'boolean', default: true }) canonical: boolean;
  @Column({ name: 'parser_version', type: 'varchar', length: 32 }) parserVersion: string;
  @CreateDateColumn({ name: 'observed_at', type: 'datetime', precision: 3 }) observedAt: Date;
}

@Entity('wc_reorgs')
export class ReorgEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true }) id: string;
  @Column({ name: 'old_tip_hash', type: 'char', length: 64 }) oldTipHash: string;
  @Column({ name: 'new_tip_hash', type: 'char', length: 64 }) newTipHash: string;
  @Column({ name: 'fork_height', type: 'int' }) forkHeight: number;
  @Column({ type: 'int', unsigned: true }) depth: number;
  @Column({ type: 'varchar', length: 16 }) status: string;
  @Column({ name: 'orphaned_blocks', type: 'int', unsigned: true, default: 0 })
  orphanedBlocks: number;
  @Column({ name: 'replayed_blocks', type: 'int', unsigned: true, default: 0 })
  replayedBlocks: number;
  @CreateDateColumn({ name: 'started_at', type: 'datetime', precision: 3 }) startedAt: Date;
  @Column({ name: 'completed_at', type: 'datetime', precision: 3, nullable: true })
  completedAt: Date | null;
}

@Entity('wc_block_undo')
export class BlockUndoEntity {
  @PrimaryColumn({ name: 'block_hash', type: 'char', length: 64 }) blockHash: string;
  @Index() @Column({ type: 'int', unsigned: true }) height: number;
  @Column({ name: 'undo_json', type: 'json' }) undoJson: Record<string, unknown>;
  @Column({ name: 'state_root_before', type: 'char', length: 64 }) stateRootBefore: string;
  @Column({ name: 'checkpoint_json_before', type: 'json' }) checkpointJsonBefore: Record<
    string,
    unknown
  >;
}

@Entity('wc_checkpoints')
export class CheckpointEntity {
  @PrimaryColumn({ type: 'varchar', length: 32, default: 'canonical' }) id: string;
  @Column({ type: 'tinyint', unsigned: true }) network: number;
  @Column({ name: 'start_height', type: 'int', unsigned: true }) startHeight: number;
  @Column({ name: 'tip_height', type: 'int' }) tipHeight: number;
  @Column({ name: 'tip_hash', type: 'char', length: 64, nullable: true }) tipHash: string | null;
  @Column({ name: 'boundary_parent_hash', type: 'char', length: 64, nullable: true })
  boundaryParentHash: string | null;
  @Column({ name: 'state_root', type: 'char', length: 64 }) stateRoot: string;
  @Column({ name: 'indexer_version', type: 'varchar', length: 32 }) indexerVersion: string;
  @Column({ name: 'parser_version', type: 'varchar', length: 32 }) parserVersion: string;
  @Column({ type: 'varchar', length: 16 }) status: string;
  @Column({ name: 'last_error', type: 'text', nullable: true }) lastError: string | null;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 }) updatedAt: Date;
}

@Entity('wc_indexer_leases')
export class IndexerLeaseEntity {
  @PrimaryColumn({ name: 'lease_name', type: 'varchar', length: 64 }) leaseName: string;
  @Column({ name: 'owner_id', type: 'varchar', length: 128 }) ownerId: string;
  @Column({ name: 'fencing_token', type: 'bigint', unsigned: true }) fencingToken: string;
  @Column({ name: 'expires_at', type: 'datetime', precision: 3 }) expiresAt: Date;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 }) updatedAt: Date;
}

@Entity('wc_indexer_versions')
export class IndexerVersionEntity {
  @PrimaryColumn({ type: 'varchar', length: 32 }) version: string;
  @Column({ name: 'git_commit', type: 'char', length: 40, nullable: true }) gitCommit:
    string | null;
  @Column({ name: 'schema_version', type: 'varchar', length: 64 }) schemaVersion: string;
  @CreateDateColumn({ name: 'started_at', type: 'datetime', precision: 3 }) startedAt: Date;
}

@Entity('wc_parser_versions')
export class ParserVersionEntity {
  @PrimaryColumn({ name: 'parser_version', type: 'varchar', length: 32 }) parserVersion: string;
  @Column({ name: 'protocol_version', type: 'tinyint', unsigned: true }) protocolVersion: number;
  @Column({ name: 'implementation_hash', type: 'char', length: 64, nullable: true })
  implementationHash: string | null;
  @CreateDateColumn({ name: 'registered_at', type: 'datetime', precision: 3 }) registeredAt: Date;
}

@Entity('wc_protocol_stats')
export class ProtocolStatEntity {
  @PrimaryColumn({ name: 'metric_key', type: 'varchar', length: 64 }) metricKey: string;
  @PrimaryColumn({ type: 'varchar', length: 80, default: 'global' }) scope: string;
  @Column({ name: 'value_decimal', type: 'decimal', precision: 36, scale: 8, default: 0 })
  valueDecimal: string;
  @Column({ name: 'value_json', type: 'json', nullable: true }) valueJson: Record<
    string,
    unknown
  > | null;
  @UpdateDateColumn({ name: 'computed_at', type: 'datetime', precision: 3 }) computedAt: Date;
}

@Entity('wc_search_documents')
@Index('uq_wc_search_owner', ['documentType', 'documentId'], { unique: true })
@Index('idx_wc_search_fulltext', ['title', 'body'], { fulltext: true })
export class SearchDocumentEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true }) id: string;
  @Column({ name: 'document_type', type: 'varchar', length: 16 }) documentType: string;
  @Column({ name: 'document_id', type: 'varchar', length: 80 }) documentId: string;
  @Column({ name: 'context_hash', type: 'char', length: 64, nullable: true }) contextHash:
    string | null;
  @Column({ type: 'varchar', length: 255 }) title: string;
  @Column({ type: 'text' }) body: string;
  @Column({ name: 'sort_height', type: 'int', unsigned: true }) sortHeight: number;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 }) updatedAt: Date;
}

@Entity('wc_metadata_references')
export class MetadataReferenceEntity {
  @PrimaryColumn({ name: 'context_hash', type: 'char', length: 64 }) contextHash: string;
  @Column({ name: 'source_uri', type: 'varchar', length: 512, nullable: true }) sourceUri:
    string | null;
  @Column({ name: 'content_hash', type: 'char', length: 64, nullable: true }) contentHash:
    string | null;
  @Column({ type: 'varchar', length: 16, default: 'unresolved' }) status: string;
  @Column({ name: 'trusted_for_protocol', type: 'boolean', default: false })
  trustedForProtocol: boolean;
  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 3 }) updatedAt: Date;
}

@Entity('wc_admin_jobs')
@Index('idx_wc_admin_jobs_status_created', ['status', 'createdAt'])
export class AdminJobEntity {
  @PrimaryColumn({ type: 'char', length: 36 }) id: string;
  @Column({ type: 'varchar', length: 24 }) kind: string;
  @Column({ name: 'from_height', type: 'int', unsigned: true, nullable: true }) fromHeight:
    number | null;
  @Column({ name: 'to_height', type: 'int', unsigned: true, nullable: true }) toHeight:
    number | null;
  @Column({ type: 'varchar', length: 16 }) status: string;
  @Column({ name: 'result_json', type: 'json', nullable: true }) resultJson: Record<
    string,
    unknown
  > | null;
  @Column({ name: 'error_text', type: 'text', nullable: true }) errorText: string | null;
  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 }) createdAt: Date;
  @Column({ name: 'completed_at', type: 'datetime', precision: 3, nullable: true })
  completedAt: Date | null;
}

export const ENTITIES = [
  BlockEntity,
  TransactionEntity,
  TransactionInputEntity,
  TransactionOutputEntity,
  CircleEntity,
  CircleMemberEntity,
  LineageEntity,
  ShardEntity,
  CircleEdgeEntity,
  LineageClosureEntity,
  MempoolTransactionEntity,
  MempoolInputEntity,
  ReplacementEntity,
  ConflictEntity,
  InvalidEventEntity,
  ReorgEntity,
  BlockUndoEntity,
  CheckpointEntity,
  IndexerLeaseEntity,
  IndexerVersionEntity,
  ParserVersionEntity,
  ProtocolStatEntity,
  SearchDocumentEntity,
  MetadataReferenceEntity,
  AdminJobEntity,
];
