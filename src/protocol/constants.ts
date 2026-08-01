export const WITC_MAGIC = Buffer.from('WITC', 'ascii');
export const WITC_VERSION = 1 as const;
export const WITC_OPCODE_CIRCLE = 1 as const;
export const WITC_MARKER_DATA_BYTES = 40;
export const WITC_MARKER_SCRIPT_BYTES = 42;
export const WITC_MIN_PARTICIPANTS = 2;
export const WITC_MAX_PARTICIPANTS = 16;
export const WITC_MIN_SHARD_SATS = 1_000n;
export const WITC_SEQUENCE = 0xffff_fffd;
export const WITC_MAX_MONEY_SATS = 2_100_000_000_000_000n;
export const PARSER_VERSION = 'witc-v1.0.0';
export const INDEXER_VERSION = '0.2.0';
export const SCHEMA_VERSION = 'witc-indexer-v2';

export enum WitnessNetwork {
  MAINNET = 0,
  TESTNET3 = 1,
  SIGNET = 2,
  REGTEST = 3,
}

export type WitnessNetworkName = 'mainnet' | 'testnet3' | 'signet' | 'regtest';

export const NETWORK_BY_NAME: Record<WitnessNetworkName, WitnessNetwork> = {
  mainnet: WitnessNetwork.MAINNET,
  testnet3: WitnessNetwork.TESTNET3,
  signet: WitnessNetwork.SIGNET,
  regtest: WitnessNetwork.REGTEST,
};

export const NETWORK_NAME_BY_BYTE: Record<WitnessNetwork, WitnessNetworkName> = {
  [WitnessNetwork.MAINNET]: 'mainnet',
  [WitnessNetwork.TESTNET3]: 'testnet3',
  [WitnessNetwork.SIGNET]: 'signet',
  [WitnessNetwork.REGTEST]: 'regtest',
};
