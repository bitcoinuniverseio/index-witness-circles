import { MigrationInterface, QueryRunner } from 'typeorm';

export const WITNESS_TABLES = [
  'wc_blocks',
  'wc_transactions',
  'wc_transaction_inputs',
  'wc_transaction_outputs',
  'wc_circles',
  'wc_lineages',
  'wc_shards',
  'wc_circle_members',
  'wc_circle_edges',
  'wc_lineage_closures',
  'wc_mempool_transactions',
  'wc_mempool_inputs',
  'wc_mempool_replacements',
  'wc_mempool_conflicts',
  'wc_invalid_events',
  'wc_reorgs',
  'wc_block_undo',
  'wc_checkpoints',
  'wc_indexer_leases',
  'wc_indexer_versions',
  'wc_parser_versions',
  'wc_protocol_stats',
  'wc_search_documents',
  'wc_metadata_references',
  'wc_admin_jobs',
] as const;

const SUFFIX = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';

export class InitWitnessV1_1796083200000 implements MigrationInterface {
  name = 'InitWitnessV1_1796083200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE wc_blocks (
      hash CHAR(64) NOT NULL,
      height INT UNSIGNED NOT NULL,
      previous_hash CHAR(64) NULL,
      time BIGINT UNSIGNED NOT NULL,
      median_time BIGINT UNSIGNED NOT NULL,
      tx_count INT UNSIGNED NOT NULL,
      parser_version VARCHAR(32) NOT NULL,
      canonical BOOLEAN NOT NULL DEFAULT TRUE,
      processed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (hash),
      KEY idx_wc_blocks_height (height),
      KEY idx_wc_blocks_canonical_height (height, canonical)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_transactions (
      txid CHAR(64) NOT NULL,
      wtxid CHAR(64) NULL,
      block_hash CHAR(64) NULL,
      block_height INT UNSIGNED NULL,
      position INT UNSIGNED NULL,
      version INT NOT NULL,
      locktime INT UNSIGNED NOT NULL,
      size INT UNSIGNED NULL,
      vsize INT UNSIGNED NULL,
      weight INT UNSIGNED NULL,
      fee_sats BIGINT UNSIGNED NULL,
      raw_hex LONGTEXT NULL,
      canonical BOOLEAN NOT NULL DEFAULT TRUE,
      confirmed BOOLEAN NOT NULL DEFAULT TRUE,
      first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (txid),
      KEY idx_wc_transactions_block_position (block_hash, position),
      KEY idx_wc_transactions_height (block_height),
      KEY idx_wc_transactions_status (canonical, confirmed),
      CONSTRAINT fk_wc_transactions_block FOREIGN KEY (block_hash) REFERENCES wc_blocks(hash)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_transaction_inputs (
      txid CHAR(64) NOT NULL,
      vin SMALLINT UNSIGNED NOT NULL,
      prev_txid CHAR(64) NULL,
      prev_vout INT UNSIGNED NULL,
      sequence BIGINT UNSIGNED NOT NULL,
      coinbase LONGTEXT NULL,
      witness_json JSON NOT NULL,
      prev_value_sats BIGINT UNSIGNED NULL,
      prev_script_hex TEXT NULL,
      prev_script_hash CHAR(64) NULL,
      prev_address VARCHAR(128) NULL,
      prev_block_height INT UNSIGNED NULL,
      PRIMARY KEY (txid, vin),
      KEY idx_wc_inputs_prevout (prev_txid, prev_vout),
      KEY idx_wc_inputs_prev_address (prev_address),
      CONSTRAINT fk_wc_inputs_transaction FOREIGN KEY (txid) REFERENCES wc_transactions(txid)
        ON DELETE CASCADE
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_transaction_outputs (
      txid CHAR(64) NOT NULL,
      vout INT UNSIGNED NOT NULL,
      value_sats BIGINT UNSIGNED NOT NULL,
      script_hex TEXT NOT NULL,
      script_hash CHAR(64) NOT NULL,
      script_type VARCHAR(32) NULL,
      address VARCHAR(128) NULL,
      is_witc_marker BOOLEAN NOT NULL DEFAULT FALSE,
      shard_lineage_id CHAR(64) NULL,
      spent_by_txid CHAR(64) NULL,
      spent_by_vin SMALLINT UNSIGNED NULL,
      spent_height INT UNSIGNED NULL,
      PRIMARY KEY (txid, vout),
      KEY idx_wc_outputs_script_hash (script_hash),
      KEY idx_wc_outputs_address (address),
      KEY idx_wc_outputs_spender (spent_by_txid),
      KEY idx_wc_outputs_lineage (shard_lineage_id),
      CONSTRAINT fk_wc_outputs_transaction FOREIGN KEY (txid) REFERENCES wc_transactions(txid)
        ON DELETE CASCADE
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_circles (
      circle_txid CHAR(64) NOT NULL,
      version TINYINT UNSIGNED NOT NULL,
      network TINYINT UNSIGNED NOT NULL,
      opcode TINYINT UNSIGNED NOT NULL,
      participant_count TINYINT UNSIGNED NOT NULL,
      context_hash CHAR(64) NOT NULL,
      marker_hex CHAR(84) NOT NULL,
      fee_sats BIGINT UNSIGNED NOT NULL,
      fresh_lineages TINYINT UNSIGNED NOT NULL,
      status VARCHAR(16) NOT NULL,
      canonical BOOLEAN NOT NULL DEFAULT TRUE,
      block_hash CHAR(64) NOT NULL,
      block_height INT UNSIGNED NOT NULL,
      tx_position INT UNSIGNED NOT NULL,
      confirmed_at DATETIME(3) NOT NULL,
      state_root_after CHAR(64) NULL,
      indexed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (circle_txid),
      KEY idx_wc_circles_status_height (status, block_height, tx_position),
      KEY idx_wc_circles_context_height (context_hash, block_height),
      KEY idx_wc_circles_block (block_hash),
      CONSTRAINT chk_wc_circles_participants CHECK (participant_count BETWEEN 2 AND 16),
      CONSTRAINT chk_wc_circles_v1 CHECK (version = 1 AND opcode = 1),
      CONSTRAINT fk_wc_circles_transaction FOREIGN KEY (circle_txid)
        REFERENCES wc_transactions(txid),
      CONSTRAINT fk_wc_circles_block FOREIGN KEY (block_hash) REFERENCES wc_blocks(hash)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_lineages (
      lineage_id CHAR(64) NOT NULL,
      genesis_txid CHAR(64) NOT NULL,
      genesis_vout INT UNSIGNED NOT NULL,
      current_txid CHAR(64) NULL,
      current_vout INT UNSIGNED NULL,
      current_value_sats BIGINT UNSIGNED NULL,
      current_script_hash CHAR(64) NULL,
      current_address VARCHAR(128) NULL,
      status VARCHAR(16) NOT NULL,
      first_height INT UNSIGNED NOT NULL,
      last_height INT UNSIGNED NOT NULL,
      circle_count INT UNSIGNED NOT NULL,
      last_circle_txid CHAR(64) NULL,
      closed_by_txid CHAR(64) NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (lineage_id),
      UNIQUE KEY uq_wc_lineages_genesis (genesis_txid, genesis_vout),
      UNIQUE KEY uq_wc_lineages_current_outpoint (current_txid, current_vout),
      KEY idx_wc_lineages_status_height (status, last_height),
      KEY idx_wc_lineages_script_hash (current_script_hash),
      KEY idx_wc_lineages_address (current_address),
      CONSTRAINT chk_wc_lineages_status CHECK (status IN ('active', 'closed'))
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_shards (
      txid CHAR(64) NOT NULL,
      vout INT UNSIGNED NOT NULL,
      lineage_id CHAR(64) NOT NULL,
      value_sats BIGINT UNSIGNED NOT NULL,
      script_hex TEXT NOT NULL,
      script_hash CHAR(64) NOT NULL,
      address VARCHAR(128) NULL,
      status VARCHAR(16) NOT NULL,
      created_circle_txid CHAR(64) NOT NULL,
      created_height INT UNSIGNED NOT NULL,
      previous_txid CHAR(64) NULL,
      previous_vout INT UNSIGNED NULL,
      spent_by_txid CHAR(64) NULL,
      spent_by_vin SMALLINT UNSIGNED NULL,
      spent_height INT UNSIGNED NULL,
      PRIMARY KEY (txid, vout),
      KEY idx_wc_shards_lineage_height (lineage_id, created_height),
      KEY idx_wc_shards_status_script (status, script_hash),
      KEY idx_wc_shards_spender (spent_by_txid),
      CONSTRAINT chk_wc_shards_minimum CHECK (value_sats >= 1000),
      CONSTRAINT chk_wc_shards_status CHECK (status IN ('active', 'spent', 'closed')),
      CONSTRAINT fk_wc_shards_lineage FOREIGN KEY (lineage_id)
        REFERENCES wc_lineages(lineage_id) ON DELETE CASCADE,
      CONSTRAINT fk_wc_shards_circle FOREIGN KEY (created_circle_txid)
        REFERENCES wc_circles(circle_txid)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_circle_members (
      circle_txid CHAR(64) NOT NULL,
      slot TINYINT UNSIGNED NOT NULL,
      lineage_id CHAR(64) NOT NULL,
      input_txid CHAR(64) NOT NULL,
      input_vout INT UNSIGNED NOT NULL,
      input_value_sats BIGINT UNSIGNED NOT NULL,
      output_vout INT UNSIGNED NOT NULL,
      output_value_sats BIGINT UNSIGNED NOT NULL,
      fee_share_sats BIGINT UNSIGNED NOT NULL,
      script_hash CHAR(64) NOT NULL,
      address VARCHAR(128) NULL,
      fresh BOOLEAN NOT NULL,
      previous_circle_txid CHAR(64) NULL,
      block_height INT UNSIGNED NOT NULL,
      PRIMARY KEY (circle_txid, slot),
      KEY idx_wc_members_input (input_txid, input_vout),
      UNIQUE KEY uq_wc_members_output (circle_txid, output_vout),
      KEY idx_wc_members_lineage_height (lineage_id, block_height),
      KEY idx_wc_members_script_hash (script_hash),
      KEY idx_wc_members_address (address),
      CONSTRAINT fk_wc_members_circle FOREIGN KEY (circle_txid)
        REFERENCES wc_circles(circle_txid) ON DELETE CASCADE,
      KEY idx_wc_members_lineage (lineage_id)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_circle_edges (
      from_circle_txid CHAR(64) NOT NULL,
      to_circle_txid CHAR(64) NOT NULL,
      lineage_id CHAR(64) NOT NULL,
      via_txid CHAR(64) NOT NULL,
      via_vout INT UNSIGNED NOT NULL,
      canonical BOOLEAN NOT NULL DEFAULT TRUE,
      block_height INT UNSIGNED NOT NULL,
      PRIMARY KEY (from_circle_txid, to_circle_txid, lineage_id, via_txid, via_vout),
      KEY idx_wc_edges_from (from_circle_txid),
      KEY idx_wc_edges_to (to_circle_txid),
      KEY idx_wc_edges_lineage (lineage_id, block_height),
      CONSTRAINT fk_wc_edges_from FOREIGN KEY (from_circle_txid)
        REFERENCES wc_circles(circle_txid),
      CONSTRAINT fk_wc_edges_to FOREIGN KEY (to_circle_txid)
        REFERENCES wc_circles(circle_txid)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_lineage_closures (
      spending_txid CHAR(64) NOT NULL,
      lineage_id CHAR(64) NOT NULL,
      spending_vin SMALLINT UNSIGNED NOT NULL,
      shard_txid CHAR(64) NOT NULL,
      shard_vout INT UNSIGNED NOT NULL,
      reason VARCHAR(32) NOT NULL,
      block_hash CHAR(64) NOT NULL,
      block_height INT UNSIGNED NOT NULL,
      canonical BOOLEAN NOT NULL DEFAULT TRUE,
      observed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (spending_txid, lineage_id),
      KEY idx_wc_closures_lineage_height (lineage_id, block_height),
      KEY idx_wc_closures_block (block_hash),
      CONSTRAINT fk_wc_closures_transaction FOREIGN KEY (spending_txid)
        REFERENCES wc_transactions(txid),
      CONSTRAINT fk_wc_closures_block FOREIGN KEY (block_hash) REFERENCES wc_blocks(hash)
    ) ${SUFFIX}`);

    await this.createOperationalTables(queryRunner);
  }

  private async createOperationalTables(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE wc_mempool_transactions (
      txid CHAR(64) NOT NULL,
      status VARCHAR(16) NOT NULL,
      raw_hex LONGTEXT NULL,
      protocol_status VARCHAR(16) NULL,
      protocol_code VARCHAR(64) NULL,
      projection_json JSON NULL,
      fee_sats BIGINT UNSIGNED NULL,
      vsize INT UNSIGNED NULL,
      first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (txid),
      KEY idx_wc_mempool_status_seen (status, last_seen_at)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_mempool_inputs (
      txid CHAR(64) NOT NULL,
      vin SMALLINT UNSIGNED NOT NULL,
      prev_txid CHAR(64) NOT NULL,
      prev_vout INT UNSIGNED NOT NULL,
      sequence BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (txid, vin),
      KEY idx_wc_mempool_inputs_outpoint (prev_txid, prev_vout),
      CONSTRAINT fk_wc_mempool_inputs_tx FOREIGN KEY (txid)
        REFERENCES wc_mempool_transactions(txid) ON DELETE CASCADE
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_mempool_replacements (
      old_txid CHAR(64) NOT NULL,
      new_txid CHAR(64) NOT NULL,
      reason VARCHAR(64) NULL,
      observed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (old_txid, new_txid),
      KEY idx_wc_replacements_new (new_txid)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_mempool_conflicts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      prev_txid CHAR(64) NOT NULL,
      prev_vout INT UNSIGNED NOT NULL,
      first_txid CHAR(64) NOT NULL,
      second_txid CHAR(64) NOT NULL,
      winner_txid CHAR(64) NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'open',
      observed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      resolved_at DATETIME(3) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_wc_conflict_pair (prev_txid, prev_vout, first_txid, second_txid),
      KEY idx_wc_conflicts_outpoint_status (prev_txid, prev_vout, status)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_invalid_events (
      txid CHAR(64) NOT NULL,
      classification VARCHAR(16) NOT NULL,
      error_code VARCHAR(64) NOT NULL,
      detail TEXT NOT NULL,
      data_hex VARCHAR(80) NULL,
      block_hash CHAR(64) NULL,
      block_height INT UNSIGNED NULL,
      mempool_only BOOLEAN NOT NULL DEFAULT FALSE,
      canonical BOOLEAN NOT NULL DEFAULT TRUE,
      parser_version VARCHAR(32) NOT NULL,
      observed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (txid),
      KEY idx_wc_invalid_code_height (error_code, block_height),
      KEY idx_wc_invalid_status (classification, canonical)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_reorgs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      old_tip_hash CHAR(64) NOT NULL,
      new_tip_hash CHAR(64) NOT NULL,
      fork_height INT UNSIGNED NOT NULL,
      depth INT UNSIGNED NOT NULL,
      status VARCHAR(16) NOT NULL,
      orphaned_blocks INT UNSIGNED NOT NULL DEFAULT 0,
      replayed_blocks INT UNSIGNED NOT NULL DEFAULT 0,
      started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      completed_at DATETIME(3) NULL,
      PRIMARY KEY (id),
      KEY idx_wc_reorgs_fork_height (fork_height)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_block_undo (
      block_hash CHAR(64) NOT NULL,
      height INT UNSIGNED NOT NULL,
      undo_json JSON NOT NULL,
      state_root_before CHAR(64) NOT NULL,
      checkpoint_json_before JSON NOT NULL,
      PRIMARY KEY (block_hash),
      KEY idx_wc_undo_height (height),
      CONSTRAINT fk_wc_undo_block FOREIGN KEY (block_hash)
        REFERENCES wc_blocks(hash) ON DELETE CASCADE
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_checkpoints (
      id VARCHAR(32) NOT NULL,
      network TINYINT UNSIGNED NOT NULL,
      start_height INT UNSIGNED NOT NULL,
      tip_height INT NOT NULL,
      tip_hash CHAR(64) NULL,
      boundary_parent_hash CHAR(64) NULL,
      state_root CHAR(64) NOT NULL,
      indexer_version VARCHAR(32) NOT NULL,
      parser_version VARCHAR(32) NOT NULL,
      status VARCHAR(16) NOT NULL,
      last_error TEXT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_indexer_leases (
      lease_name VARCHAR(64) NOT NULL,
      owner_id VARCHAR(128) NOT NULL,
      fencing_token BIGINT UNSIGNED NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (lease_name),
      KEY idx_wc_leases_expires (expires_at)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_indexer_versions (
      version VARCHAR(32) NOT NULL,
      git_commit CHAR(40) NULL,
      schema_version VARCHAR(64) NOT NULL,
      started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (version)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_parser_versions (
      parser_version VARCHAR(32) NOT NULL,
      protocol_version TINYINT UNSIGNED NOT NULL,
      implementation_hash CHAR(64) NULL,
      registered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (parser_version)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_protocol_stats (
      metric_key VARCHAR(64) NOT NULL,
      scope VARCHAR(80) NOT NULL DEFAULT 'global',
      value_decimal DECIMAL(36,8) NOT NULL DEFAULT 0,
      value_json JSON NULL,
      computed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (metric_key, scope)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_search_documents (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      document_type VARCHAR(16) NOT NULL,
      document_id VARCHAR(80) NOT NULL,
      context_hash CHAR(64) NULL,
      title VARCHAR(255) NOT NULL,
      body TEXT NOT NULL,
      sort_height INT UNSIGNED NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_wc_search_owner (document_type, document_id),
      KEY idx_wc_search_context (context_hash),
      FULLTEXT KEY idx_wc_search_fulltext (title, body)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_metadata_references (
      context_hash CHAR(64) NOT NULL,
      source_uri VARCHAR(512) NULL,
      content_hash CHAR(64) NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'unresolved',
      trusted_for_protocol BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (context_hash),
      CONSTRAINT chk_wc_metadata_untrusted CHECK (trusted_for_protocol = FALSE)
    ) ${SUFFIX}`);

    await queryRunner.query(`CREATE TABLE wc_admin_jobs (
      id CHAR(36) NOT NULL,
      kind VARCHAR(24) NOT NULL,
      from_height INT UNSIGNED NULL,
      to_height INT UNSIGNED NULL,
      status VARCHAR(16) NOT NULL,
      result_json JSON NULL,
      error_text TEXT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      completed_at DATETIME(3) NULL,
      PRIMARY KEY (id),
      KEY idx_wc_admin_jobs_status_created (status, created_at)
    ) ${SUFFIX}`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
      for (const table of [...WITNESS_TABLES].reverse()) {
        await queryRunner.query(`DROP TABLE IF EXISTS \`${table}\``);
      }
    } finally {
      await queryRunner.query('SET FOREIGN_KEY_CHECKS = 1');
    }
  }
}
