import { WitnessNetworkName } from '../protocol';

const VALID_NODE_ENVS = new Set(['development', 'production', 'test']);
const SAFE_LISTEN_HOSTS = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);
const PLACEHOLDER =
  /^(?:change(?:me)?|example|placeholder|replace(?:me)?|todo|your)(?:[\s_.-].*)?$/i;

function integer(name: string, fallback: number, minimum = 0, maximum?: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || (maximum !== undefined && value > maximum)) {
    throw new Error(
      `${name} must be an integer from ${minimum}${maximum === undefined ? '' : ` to ${maximum}`}`,
    );
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function productionSecret(name: string, fallback: string, nodeEnv: string): string {
  const value = process.env[name] ?? fallback;
  if (
    nodeEnv === 'production' &&
    (process.env[name] === undefined || value.length < 32 || PLACEHOLDER.test(value))
  ) {
    throw new Error(`${name} must be an explicit non-placeholder value of at least 32 characters`);
  }
  return value;
}

function httpOrigin(name: string, value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.replace(/\/+$/, ''));
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) origin`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be an HTTP(S) origin without credentials or a path`);
  }
  return parsed.origin;
}

function optionalZmq(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!/^(?:tcp|ipc):\/\//.test(value)) throw new Error(`${name} must use tcp:// or ipc://`);
  return value;
}

function commaList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

export interface AppConfiguration {
  nodeEnv: string;
  listenHost: string;
  port: number;
  publicBaseUrl: string;
  logLevel: string;
  network: WitnessNetworkName;
  sourceRevision: string | null;
  indexer: {
    enabled: boolean;
    startHeight: number;
    blockPollMs: number;
    mempoolPollMs: number;
    confirmations: number;
    leaseTtlMs: number;
    leaseRenewMs: number;
    instanceId: string | null;
    mempoolRetentionDays: number;
  };
  database: {
    host: string;
    readHosts: string[];
    port: number;
    database: string;
    username: string;
    password: string;
    poolSize: number;
    ssl: boolean;
  };
  bitcoin: {
    rpcUrl: string;
    rpcUser: string;
    rpcPassword: string;
    rpcTimeoutMs: number;
    zmqHashBlock?: string;
    zmqRawTx?: string;
    zmqSequence?: string;
  };
  security: {
    adminApiKeys: string[];
    publicRateLimitTtlMs: number;
    publicRateLimitMax: number;
    adminRateLimitMax: number;
    corsOrigins: string[];
    websocketMaxConnections: number;
    websocketMaxConnectionsPerIp: number;
    websocketRateLimitWindowMs: number;
    websocketRateLimitMax: number;
    websocketMaxMessageBytes: number;
    websocketMaxRoomsPerConnection: number;
  };
}

export function configuration(): AppConfiguration {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (!VALID_NODE_ENVS.has(nodeEnv)) {
    throw new Error('NODE_ENV must be development, production, or test');
  }
  const listenHost = process.env.LISTEN_HOST ?? '127.0.0.1';
  if (!SAFE_LISTEN_HOSTS.has(listenHost)) throw new Error('LISTEN_HOST is not allowed');
  const port = integer('PORT', 3012, 1, 65535);
  const network = (process.env.WITNESS_NETWORK ?? 'regtest') as WitnessNetworkName;
  if (!['signet', 'regtest'].includes(network)) {
    throw new Error('WITNESS_NETWORK must be signet or regtest');
  }
  const sourceRevision = process.env.WITNESS_SOURCE_REVISION?.trim() || null;
  if (sourceRevision !== null && !/^[0-9a-fA-F]{40}$/.test(sourceRevision)) {
    throw new Error('WITNESS_SOURCE_REVISION must be exactly 40 hexadecimal characters');
  }
  if (nodeEnv === 'production' && sourceRevision === null) {
    throw new Error('WITNESS_SOURCE_REVISION is required in production');
  }
  const leaseTtlMs = integer('INDEXER_LEASE_TTL_MS', 30_000, 5_000);
  const leaseRenewMs = integer('INDEXER_LEASE_RENEW_MS', 10_000, 1_000);
  if (leaseRenewMs * 2 >= leaseTtlMs) {
    throw new Error('INDEXER_LEASE_RENEW_MS must be less than half INDEXER_LEASE_TTL_MS');
  }
  const confirmations = integer('INDEXER_CONFIRMATIONS', 6, 1);
  const publicBaseUrl = httpOrigin(
    'PUBLIC_BASE_URL',
    process.env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${port}`,
  );
  if (nodeEnv === 'production' && !publicBaseUrl.startsWith('https://')) {
    throw new Error('PUBLIC_BASE_URL must use HTTPS in production');
  }
  const bitcoin: AppConfiguration['bitcoin'] = {
    rpcUrl: httpOrigin('BITCOIN_RPC_URL', process.env.BITCOIN_RPC_URL ?? 'http://127.0.0.1:18443'),
    rpcUser: productionSecret('BITCOIN_RPC_USER', 'bitcoin', nodeEnv),
    rpcPassword: productionSecret('BITCOIN_RPC_PASSWORD', '', nodeEnv),
    rpcTimeoutMs: integer('BITCOIN_RPC_TIMEOUT_MS', 30_000, 1_000),
  };
  const zmqHashBlock = optionalZmq('BITCOIN_ZMQ_HASHBLOCK');
  const zmqRawTx = optionalZmq('BITCOIN_ZMQ_RAWTX');
  const zmqSequence = optionalZmq('BITCOIN_ZMQ_SEQUENCE');
  if (zmqHashBlock) bitcoin.zmqHashBlock = zmqHashBlock;
  if (zmqRawTx) bitcoin.zmqRawTx = zmqRawTx;
  if (zmqSequence) bitcoin.zmqSequence = zmqSequence;

  const adminApiKeys = commaList(process.env.ADMIN_API_KEYS ?? '');
  if (
    nodeEnv === 'production' &&
    (adminApiKeys.length === 0 ||
      adminApiKeys.some((key) => key.length < 32 || PLACEHOLDER.test(key)))
  ) {
    throw new Error('Production ADMIN_API_KEYS must contain strong non-placeholder keys');
  }
  const websocketMaxConnections = integer('WEBSOCKET_MAX_CONNECTIONS', 1_000, 1);
  const websocketMaxConnectionsPerIp = integer('WEBSOCKET_MAX_CONNECTIONS_PER_IP', 50, 1);
  if (websocketMaxConnectionsPerIp > websocketMaxConnections) {
    throw new Error('WEBSOCKET_MAX_CONNECTIONS_PER_IP cannot exceed the global maximum');
  }

  return {
    nodeEnv,
    listenHost,
    port,
    publicBaseUrl,
    logLevel: process.env.LOG_LEVEL ?? 'info',
    network,
    sourceRevision,
    indexer: {
      enabled: bool('INDEXER_ENABLED', true),
      startHeight: integer('INDEXER_START_HEIGHT', 0),
      blockPollMs: integer('INDEXER_BLOCK_POLL_MS', 10_000, 1_000),
      mempoolPollMs: integer('INDEXER_MEMPOOL_POLL_MS', 15_000, 1_000),
      confirmations,
      leaseTtlMs,
      leaseRenewMs,
      instanceId: process.env.INDEXER_INSTANCE_ID?.trim() || null,
      mempoolRetentionDays: integer('MEMPOOL_RETENTION_DAYS', 14, 1, 365),
    },
    database: {
      host: process.env.MYSQL_HOST ?? '127.0.0.1',
      readHosts: commaList(process.env.MYSQL_READ_HOSTS ?? ''),
      port: integer('MYSQL_PORT', 3306, 1, 65535),
      database: process.env.MYSQL_DATABASE ?? 'witness_circles',
      username: process.env.MYSQL_USER ?? 'witness',
      password: productionSecret('MYSQL_PASSWORD', '', nodeEnv),
      poolSize: integer('MYSQL_POOL_SIZE', 10, 1, 500),
      ssl: bool('MYSQL_SSL', false),
    },
    bitcoin,
    security: {
      adminApiKeys,
      publicRateLimitTtlMs: integer('PUBLIC_RATE_LIMIT_TTL_MS', 60_000, 1_000),
      publicRateLimitMax: integer('PUBLIC_RATE_LIMIT_MAX', 120, 1),
      adminRateLimitMax: integer('ADMIN_RATE_LIMIT_MAX', 10, 1),
      corsOrigins: commaList(process.env.CORS_ORIGINS ?? '').map((origin) =>
        httpOrigin('CORS_ORIGINS entry', origin),
      ),
      websocketMaxConnections,
      websocketMaxConnectionsPerIp,
      websocketRateLimitWindowMs: integer('WEBSOCKET_RATE_LIMIT_WINDOW_MS', 10_000, 1_000),
      websocketRateLimitMax: integer('WEBSOCKET_RATE_LIMIT_MAX', 100, 1),
      websocketMaxMessageBytes: integer('WEBSOCKET_MAX_MESSAGE_BYTES', 16_384, 1_024),
      websocketMaxRoomsPerConnection: integer('WEBSOCKET_MAX_ROOMS_PER_CONNECTION', 32, 1),
    },
  };
}

export function validateEnvironment(environment: Record<string, unknown>): Record<string, unknown> {
  void environment;
  configuration();
  return process.env;
}
