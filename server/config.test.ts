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
  for (const key of graphKeys) vi.stubEnv(key, '');
  for (const [key, value] of Object.entries({ ...base, ...env })) vi.stubEnv(key, value);
  return (await import('./config.js')).config;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('Graph email configuration', () => {
  it('defaults the Graph tenant and client to the Entra app registration', async () => {
    const config = await load({ GRAPH_CLIENT_SECRET: 'secret', MAIL_FROM_ADDRESS: 'admissions@example.test' });
    expect(config).toMatchObject({ emailEnabled: true, GRAPH_TENANT_ID: tenant, GRAPH_CLIENT_ID: client });
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
