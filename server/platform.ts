import { brandSchema, centralUserSchema } from '../shared/contracts.js';
import { config } from './config.js';
import { HttpError, logger } from './errors.js';

export async function portalFetch(path: string, options: RequestInit = {}) {
  try {
    const response = await fetch(`${config.APPLICATIONS_PORTAL_URL}${path}`, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      if ([401, 403, 404].includes(response.status) && path.startsWith('/api/platform/')) {
        throw new HttpError(response.status, 'Central sign-in or account validation failed. Contact your portal administrator.', 'CENTRAL_ACCESS_DENIED');
      }
      throw new HttpError(503, 'The Applications Portal is unavailable. Please try again later.', 'PLATFORM_UNAVAILABLE');
    }
    return response;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    logger.error({ path, errorType: error instanceof Error ? error.name : 'Unknown' }, 'Central platform request failed');
    throw new HttpError(503, 'The Applications Portal is unavailable. Please try again later.', 'PLATFORM_UNAVAILABLE');
  }
}
export async function centralSession(idToken: string) {
  const response = await portalFetch('/api/platform/v1/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-platform-key': config.PLATFORM_API_KEY },
    body: JSON.stringify({ idToken }),
  });
  return parseUser(await response.json());
}
export async function centralUser(id: number) {
  const user = parseUser(await (await portalFetch(`/api/platform/v1/users/${id}`, {
    headers: { 'x-platform-key': config.PLATFORM_API_KEY },
  })).json());
  if (user.id !== id) throw new HttpError(503, 'The central platform returned an inconsistent account.', 'PLATFORM_INVALID_RESPONSE');
  return user;
}
function parseUser(value: unknown) {
  const parsed = centralUserSchema.safeParse(value);
  if (!parsed.success) {
    logger.error('The central platform returned an invalid identity contract');
    throw new HttpError(503, 'The central platform returned an invalid account response.', 'PLATFORM_INVALID_RESPONSE');
  }
  return parsed.data;
}
export async function getBrand() {
  const parsed = brandSchema.safeParse(await (await portalFetch('/api/branding')).json());
  if (!parsed.success) throw new HttpError(503, 'Shared branding is unavailable or invalid.', 'PLATFORM_INVALID_RESPONSE');
  const brand = parsed.data;
  const asset = (value: string | null) => value && /^\/api\/branding\/assets\/(logo|footerLogo|icon|background)$/.test(value) ? value : null;
  return {
    ...brand,
    logoUrl: asset(brand.logoUrl), footerLogoUrl: asset(brand.footerLogoUrl),
    iconUrl: asset(brand.iconUrl), backgroundUrl: asset(brand.backgroundUrl),
  };
}
