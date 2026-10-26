import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

afterEach(() => vi.unstubAllGlobals());
describe('API errors', () => {
  it('surfaces a clear message when a proxy returns an empty/non-JSON error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 502 })));
    await expect(api('/api/config')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('server is unavailable') });
  });
  it('preserves API validation errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Check your fields.' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })));
    await expect(api('/api/requests', 'POST', {})).rejects.toMatchObject({ status: 400, message: 'Check your fields.' });
  });
  it('uses same-origin credentials and JSON for writes', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(api('/api/test', 'POST', { value: 1 })).resolves.toEqual({ ok: true });
    expect(fetcher).toHaveBeenCalledWith('/api/test', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: '{"value":1}',
    }));
  });
});
