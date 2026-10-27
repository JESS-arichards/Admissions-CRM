import { z } from 'zod';

const optional = z.string().trim().optional().transform((v) => v || undefined);
const bool = (fallback: boolean) => z.enum(['true', 'false']).optional().transform((v) => v === undefined ? fallback : v === 'true');
const absoluteUrl = z.url().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
    && (url.protocol === 'https:' || (process.env.NODE_ENV !== 'production'
      && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
}, 'Use an HTTPS origin without path, credentials, query or fragment (localhost HTTP allowed in development).');

const env = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8081),
  PUBLIC_BASE_URL: absoluteUrl,
  APPLICATIONS_PORTAL_URL: absoluteUrl,
  PLATFORM_API_KEY: z.string().min(32),
  SESSION_SECRET: z.string().min(32),
  ENTRA_TENANT_ID: z.uuid(),
  ENTRA_CLIENT_ID: z.uuid(),
  SQL_CONNECTION_STRING: optional,
  SQLAZURECONNSTR_DefaultConnection: optional,
  SQL_SERVER: optional,
  SQL_DATABASE: optional,
  SQL_AUTH: z.enum(['sql', 'managed-identity']).default('managed-identity'),
  SQL_USER: optional,
  SQL_PASSWORD: optional,
  SQL_MANAGED_IDENTITY_CLIENT_ID: optional,
  AZURE_STORAGE_CONNECTION_STRING: optional.pipe(z.string().refine((value) => {
    if (/SharedAccessSignature|UseDevelopmentStorage/i.test(value) || !/(?:^|;)AccountKey=[^;]+/i.test(value)) return false;
    if (/(?:^|;)DefaultEndpointsProtocol=/i.test(value) && !/(?:^|;)DefaultEndpointsProtocol=https(?:;|$)/i.test(value)) return false;
    for (const match of value.matchAll(/(?:^|;)\w*Endpoint=([^;]+)/gi)) {
      try {
        const url = new URL(match[1]);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return false;
      } catch { return false; }
    }
    return true;
  }, 'Use an HTTPS Azure account-key connection string, not SAS or development storage.').optional()),
  AZURE_STORAGE_CONTAINER: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/).default('admissions-files'),
  SQL_ENCRYPT: bool(true),
  SQL_TRUST_SERVER_CERTIFICATE: bool(false),
  GRAPH_TENANT_ID: optional.pipe(z.uuid().optional()),
  GRAPH_CLIENT_ID: optional.pipe(z.uuid().optional()),
  GRAPH_CLIENT_SECRET: optional,
  MAIL_FROM_ADDRESS: optional.pipe(z.email().optional()),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),
}).parse(process.env);

if (!(env.SQL_CONNECTION_STRING || env.SQLAZURECONNSTR_DefaultConnection || (env.SQL_SERVER && env.SQL_DATABASE))) {
  throw new Error('Configure the Admissions SQL database before starting.');
}
if (env.SQL_AUTH === 'sql' && !env.SQL_CONNECTION_STRING && !env.SQLAZURECONNSTR_DefaultConnection
  && (!env.SQL_USER || !env.SQL_PASSWORD)) throw new Error('SQL authentication requires SQL_USER and SQL_PASSWORD.');
// Like the Applications Portal, Graph mail uses the Entra app registration unless overridden.
const graphTenantId = env.GRAPH_TENANT_ID ?? env.ENTRA_TENANT_ID;
const graphClientId = env.GRAPH_CLIENT_ID ?? env.ENTRA_CLIENT_ID;
const mailFields = [env.GRAPH_CLIENT_SECRET, env.MAIL_FROM_ADDRESS];
if (mailFields.some(Boolean) && !mailFields.every(Boolean)) {
  throw new Error('Configure both GRAPH_CLIENT_SECRET and MAIL_FROM_ADDRESS to enable email, or leave both unset.');
}
export const config = {
  ...env,
  GRAPH_TENANT_ID: graphTenantId,
  GRAPH_CLIENT_ID: graphClientId,
  PUBLIC_BASE_URL: new URL(env.PUBLIC_BASE_URL).origin,
  APPLICATIONS_PORTAL_URL: new URL(env.APPLICATIONS_PORTAL_URL).origin,
  emailEnabled: mailFields.every(Boolean),
};
