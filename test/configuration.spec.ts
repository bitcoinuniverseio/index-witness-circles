import { configuration } from '../src/config/configuration';

describe('configuration', () => {
  const original = process.env;

  beforeEach(() => {
    process.env = { NODE_ENV: 'test' };
  });

  afterAll(() => {
    process.env = original;
  });

  it('uses isolated regtest defaults', () => {
    const config = configuration();
    expect(config.network).toBe('regtest');
    expect(config.listenHost).toBe('127.0.0.1');
    expect(config.database.database).toBe('witness_circles');
  });

  it('rejects invalid networks, origins, booleans, and lease timing', () => {
    process.env.WITNESS_NETWORK = 'testnet4';
    expect(() => configuration()).toThrow('WITNESS_NETWORK');
    process.env.WITNESS_NETWORK = 'regtest';
    process.env.PUBLIC_BASE_URL = 'http://user:password@example.test/path';
    expect(() => configuration()).toThrow('PUBLIC_BASE_URL');
    process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3012';
    process.env.MYSQL_SSL = 'yes';
    expect(() => configuration()).toThrow('MYSQL_SSL');
    process.env.MYSQL_SSL = 'false';
    process.env.INDEXER_LEASE_RENEW_MS = '15000';
    expect(() => configuration()).toThrow('INDEXER_LEASE_RENEW_MS');
  });

  it('fails closed on production placeholders and missing provenance', () => {
    process.env = {
      NODE_ENV: 'production',
      PUBLIC_BASE_URL: 'https://witness.example',
      WITNESS_NETWORK: 'mainnet',
    };
    expect(() => configuration()).toThrow('WITNESS_SOURCE_REVISION');
    process.env.WITNESS_SOURCE_REVISION = 'ab'.repeat(20);
    expect(() => configuration()).toThrow('BITCOIN_RPC_USER');
  });
});
