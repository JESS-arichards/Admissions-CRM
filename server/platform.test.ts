import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./config.js', () => ({ config: {
  APPLICATIONS_PORTAL_URL: 'https://portal.example.test',
  PLATFORM_API_KEY: 'server-only-test-service-key',
  LOG_LEVEL: 'silent',
} }));
import { centralSession, centralUser, getBrand } from './platform.js';

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const user = { id: 1, displayName: 'Test Staff', email: 'staff@example.test', isActive: true, sessionVersion: 0, roles: ['Full Admin'] };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => { fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); });
afterEach(() => vi.unstubAllGlobals());
describe('central platform contract', () => {
  it('exchanges the Entra ID token server-to-server using the Admissions service key', async () => {
    fetcher.mockResolvedValue(response(user));
    expect(await centralSession('id-token')).toEqual(user);
    expect(fetcher).toHaveBeenCalledWith('https://portal.example.test/api/platform/v1/session', expect.objectContaining({
      method: 'POST', body: '{"idToken":"id-token"}',
      headers: { 'Content-Type': 'application/json', 'x-platform-key': 'server-only-test-service-key' },
      redirect: 'error',
    }));
  });
  it('loads the current central user with no local role fallback', async () => {
    fetcher.mockResolvedValue(response(user));
    await centralUser(1);
    expect(fetcher.mock.calls[0][0]).toBe('https://portal.example.test/api/platform/v1/users/1');
    expect(fetcher.mock.calls[0][1].headers['x-platform-key']).toBe('server-only-test-service-key');
  });
  it.each([401, 403, 404, 500, 503])('surfaces central HTTP %i', async (status) => {
    fetcher.mockResolvedValue(response({ error: 'central failure' }, status));
    await expect(centralUser(1)).rejects.toMatchObject({ status: status < 500 ? status : 503 });
  });
  it('turns network failures into an explicit availability error', async () => {
    fetcher.mockRejectedValue(new TypeError('Network failed'));
    await expect(centralUser(1)).rejects.toMatchObject({ status: 503 });
  });
  it('rejects malformed identity contracts', async () => {
    fetcher.mockResolvedValue(response({ id: 1, roles: ['Full Admin'] }));
    await expect(centralUser(1)).rejects.toThrow();
  });
  it('returns shared brand fields without private Portal settings or service credentials', async () => {
    fetcher.mockResolvedValue(response({
      organisationName: 'School', primaryColor: '#002454', backgroundColor: '', accentColor: '', textColor: '',
      logoUrl: '/api/branding/assets/logo', footerLogoUrl: '/api/branding/assets/footerLogo',
      iconUrl: 'https://other.example.test/icon', backgroundUrl: null, websiteUrl: '', valuesTitle: '', homeValues: '',
      notificationFromEmail: 'private@example.test', appName: 'Applications Portal', PLATFORM_API_KEY: 'private',
    }));
    const brand = await getBrand();
    expect(brand.logoUrl).toBe('/api/branding/assets/logo');
    expect(brand.iconUrl).toBeNull();
    expect(brand).not.toHaveProperty('notificationFromEmail');
    expect(brand).not.toHaveProperty('PLATFORM_API_KEY');
    expect(brand).not.toHaveProperty('appName');
  });
});
