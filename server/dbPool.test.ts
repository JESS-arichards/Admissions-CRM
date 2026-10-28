import { beforeEach, describe, expect, it, vi } from 'vitest';
import sql from 'mssql';

const state = vi.hoisted(() => ({
  config: {
    SQL_SERVERLESS_ENABLED: false,
    SQL_CONNECTION_STRING: '',
    SQLAZURECONNSTR_DefaultConnection: '',
    SQL_SERVER: 'discrete.example.test', SQL_DATABASE: 'discrete-db',
    SQL_AUTH: 'sql', SQL_USER: 'discrete-user', SQL_PASSWORD: 'discrete-password',
    SQL_ENCRYPT: true, SQL_TRUST_SERVER_CERTIFICATE: false, LOG_LEVEL: 'silent',
  },
}));
vi.mock('./config.js', () => ({ config: state.config }));

beforeEach(() => {
  vi.resetModules();
  state.config.SQL_SERVERLESS_ENABLED = false;
  state.config.SQL_CONNECTION_STRING = '';
  state.config.SQLAZURECONNSTR_DefaultConnection = '';
});
const connection = 'Server=primary.example.test;Database=primary-db;User Id=string-user;Password=string-password;Min Pool Size=4;Max Pool Size=8;Connect Timeout=60';

describe('serverless pool configuration using the real mssql parser', () => {
  it('overrides connection-string pool settings but preserves credentials and precedence', async () => {
    state.config.SQL_SERVERLESS_ENABLED = true;
    state.config.SQL_CONNECTION_STRING = connection;
    state.config.SQLAZURECONNSTR_DefaultConnection = 'Server=ignored.example.test;Database=ignored';
    const { pool } = await import('./db.js');
    expect(pool).toBeInstanceOf(sql.ConnectionPool);
    expect(pool.config).toMatchObject({
      server: 'primary.example.test', database: 'primary-db',
      user: 'string-user', password: 'string-password',
      pool: { min: 0, max: 8, idleTimeoutMillis: 30000 },
      connectionTimeout: 10000, options: { connectTimeout: 10000 },
    });
  });
  it('also applies to Azure connection strings and discrete credentials', async () => {
    state.config.SQL_SERVERLESS_ENABLED = true;
    state.config.SQLAZURECONNSTR_DefaultConnection = connection;
    expect((await import('./db.js')).pool.config.pool).toMatchObject({ min: 0, idleTimeoutMillis: 30000 });
    vi.resetModules();
    state.config.SQLAZURECONNSTR_DefaultConnection = '';
    expect((await import('./db.js')).pool.config).toMatchObject({
      server: 'discrete.example.test', user: 'discrete-user', password: 'discrete-password',
      pool: { min: 0, idleTimeoutMillis: 30000 },
    });
  });
  it('does not alter normal-mode connection-string settings', async () => {
    state.config.SQL_CONNECTION_STRING = connection;
    expect((await import('./db.js')).pool.config).toMatchObject({
      pool: { min: 4, max: 8 }, connectionTimeout: 60000,
    });
  });
});
