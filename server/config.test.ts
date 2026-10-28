import { afterEach, describe, expect, it, vi } from 'vitest';

const tenant = '11111111-1111-4111-8111-111111111111';
const client = '22222222-2222-4222-8222-222222222222';
const base = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'https://admissions.example.test',
  APPLICATIONS_PORTAL_URL: 'https://portal.example.test',
  PLATFORM_API_KEY: 'p'.repeat(32),
  SESSION_SECRET: 's'.repeat(32),
  ENTRA_TENANT_ID: tenant,
  ENTRA_CLIENT_ID: client,
  SQL_SERVER: 'sql.example.test',
  SQL_DATABASE: 'admissions',
};
const graphKeys = ['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'MAIL_FROM_ADDRESS'];

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const key of [...graphKeys, 'AZURE_STORAGE_CONNECTION_STRING']) vi.stubEnv(key, '');
  vi.stubEnv('AZURE_STORAGE_CONTAINER', undefined);
  vi.stubEnv('SQL_SERVERLESS_ENABLED', undefined);
  for (const [key, value] of Object.entries({ ...base, ...env })) vi.stubEnv(key, value);
  return (await import('./config.js')).config;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('optional SQL serverless configuration', () => {
  it('defaults off, including production', async () => {
    expect((await load({})).SQL_SERVERLESS_ENABLED).toBe(false);
    expect((await load({ NODE_ENV: 'production' })).SQL_SERVERLESS_ENABLED).toBe(false);
  });
  it.each(['true', 'false'])('accepts explicit %s', async (value) => {
    expect((await load({ SQL_SERVERLESS_ENABLED: value })).SQL_SERVERLESS_ENABLED).toBe(value === 'true');
  });
  it.each(['1', 'yes', 'TRUE', ''])('rejects invalid boolean %j', async (value) => {
    await expect(load({ SQL_SERVERLESS_ENABLED: value })).rejects.toThrow();
  });
});

describe('Graph email configuration', () => {
  it('defaults the Graph tenant and client to the Entra app registration', async () => {
    const config = await load({ GRAPH_CLIENT_SECRET: 'secret', MAIL_FROM_ADDRESS: 'admissions@example.test' });
    expect(config).toMatchObject({ emailEnabled: true, GRAPH_TENANT_ID: tenant, GRAPH_CLIENT_ID: client });
  });
  describe('Azure document configuration', () => {
    it('is optional and defaults to the private Admissions container name', async () => {
      expect(await load({})).toMatchObject({ AZURE_STORAGE_CONTAINER:       'admissions-files', AZURE_STORAGE_CONNECTION_STRING: undefined });
          });
          it('accepts the Portal connection string and container names', async () => {
            const connection = 'DefaultEndpointsProtocol=https;AccountName=account;AccountKey=example;EndpointSuffix=core.windows.net';
            expect(await load({ AZURE_STORAGE_CONNECTION_STRING: connection, AZURE_STORAGE_CONTAINER: 'admissions-dev' }))
              .toMatchObject({ AZURE_STORAGE_CONNECTION_STRING: connection, AZURE_STORAGE_CONTAINER: 'admissions-dev' });
          });
          it.each([      { AZURE_STORAGE_CONNECTION_STRING: 'SharedAccessSignature=secret;BlobEndpoint=https://account.blob.core.windows.net' },
      { AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true' },
      { AZURE_STORAGE_CONNECTION_STRING: 'AccountKey=key;BlobEndpoint=https://account.blob.core.windows.net?sig=secret' },
    ])('rejects SAS URLs, non-HTTPS origins and local fallback: %j', async (env) => {
      await expect(load(env)).rejects.toThrow();
    });
  });

  it('honours explicit Graph overrides', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    const config = await load({ GRAPH_TENANT_ID: other, GRAPH_CLIENT_ID: other, GRAPH_CLIENT_SECRET: 'secret', MAIL_FROM_ADDRESS: 'admissions@example.test' });
    expect(config).toMatchObject({ GRAPH_TENANT_ID: other, GRAPH_CLIENT_ID: other });
  });

  it('disables email when no mail settings are configured', async () => {
    expect((await load({})).emailEnabled).toBe(false);
  });

  it('rejects a partial mail configuration', async () => {
    await expect(load({ MAIL_FROM_ADDRESS: 'admissions@example.test' })).rejects.toThrow(/GRAPH_CLIENT_SECRET and MAIL_FROM_ADDRESS/);
  });

  it('rejects malformed Graph identifiers', async () => {
    await expect(load({ GRAPH_CLIENT_ID: 'not-a-uuid', GRAPH_CLIENT_SECRET: 'secret', MAIL_FROM_ADDRESS: 'admissions@example.test' })).rejects.toThrow();
  });
});
