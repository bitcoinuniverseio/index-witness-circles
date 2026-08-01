import { MigrationInterface, QueryRunner } from 'typeorm';

const CANONICAL_EMPTY_STATE_ROOT =
  '90e749b7720fac379610d979e29998c7d650150548622f0a47d9d3e181f1be52';

// State roots published before this migration used a noncanonical projection. They cannot be
// converted without replaying chain data, and legacy undo roots cannot safely cross the activation
// boundary. Delete only chain-derived projections and reset the canonical checkpoint so the normal
// coordinator performs a mandatory replay from INDEXER_START_HEIGHT.
const CHAIN_DERIVED_RESET_ORDER = [
  'wc_circle_edges',
  'wc_circle_members',
  'wc_lineage_closures',
  'wc_shards',
  'wc_lineages',
  'wc_circles',
  'wc_transaction_inputs',
  'wc_transaction_outputs',
  'wc_block_undo',
  'wc_transactions',
  'wc_invalid_events',
  'wc_mempool_inputs',
  'wc_mempool_replacements',
  'wc_mempool_conflicts',
  'wc_mempool_transactions',
  'wc_search_documents',
  'wc_protocol_stats',
  'wc_reorgs',
  'wc_blocks',
] as const;

export class HardenWitnessState1796083201000 implements MigrationInterface {
  name = 'HardenWitnessState1796083201000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasColumn('wc_mempool_transactions', 'evaluated_tip_height'))) {
      await queryRunner.query(
        'ALTER TABLE wc_mempool_transactions ADD COLUMN evaluated_tip_height INT UNSIGNED NULL AFTER protocol_code',
      );
    }
    if (!(await queryRunner.hasColumn('wc_mempool_transactions', 'evaluated_tip_hash'))) {
      await queryRunner.query(
        'ALTER TABLE wc_mempool_transactions ADD COLUMN evaluated_tip_hash CHAR(64) NULL AFTER evaluated_tip_height',
      );
    }
    await queryRunner.query('ALTER TABLE wc_reorgs MODIFY COLUMN fork_height INT NOT NULL');
    await queryRunner.query(`UPDATE wc_shards s
      JOIN wc_circle_members m
        ON m.circle_txid = s.created_circle_txid
       AND m.output_vout = s.vout
       AND m.lineage_id = s.lineage_id
      SET s.previous_txid = m.input_txid, s.previous_vout = m.input_vout
      WHERE s.previous_txid IS NULL OR s.previous_vout IS NULL`);
    for (const table of CHAIN_DERIVED_RESET_ORDER) {
      await queryRunner.query(`DELETE FROM ${table}`);
    }
    await queryRunner.query(
      `INSERT INTO wc_indexer_versions (version, git_commit, schema_version)
       VALUES ('0.2.0', NULL, 'witc-indexer-v2')
       ON DUPLICATE KEY UPDATE schema_version = VALUES(schema_version)`,
    );
    await queryRunner.query(
      `UPDATE wc_checkpoints
       SET tip_height = CAST(start_height AS SIGNED) - 1,
           tip_hash = boundary_parent_hash,
           state_root = ?,
           indexer_version = '0.2.0',
           status = 'reindexing',
           last_error = 'Canonical state-root v1 activation requires a full chain replay'`,
      [CANONICAL_EMPTY_STATE_ROOT],
    );
  }

  async down(): Promise<void> {
    throw new Error(
      'HardenWitnessState1796083201000 is irreversible because activation deletes noncanonical projections; restore a pre-migration database backup instead',
    );
  }
}
