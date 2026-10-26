import type { PublicClientApplication } from '@azure/msal-browser';
import type { PublicConfig } from '../../shared/contracts';

let instance: PublicClientApplication | null = null;
let init: Promise<PublicClientApplication> | null = null;
async function msal(config: PublicConfig) {
  init ??= (async () => {
    const { PublicClientApplication } = await import('@azure/msal-browser');
    const app = new PublicClientApplication({
      auth: {
        clientId: config.entra.clientId,
        authority: config.entra.authority,
        redirectUri: `${window.location.origin}/auth/callback.html`,
      },
      cache: { cacheLocation: 'sessionStorage' },
    });
    await app.initialize();
    instance = app;
    return app;
  })();
  return init;
}
export async function login(config: PublicConfig) {
  const app = await msal(config);
  const result = await app.loginPopup({ scopes: ['openid', 'profile', 'email'], prompt: 'select_account' });
  return result.idToken;
}
export async function clearLogin() { await instance?.clearCache(); }
