import { broadcastResponseToMainFrame } from '@azure/msal-browser/redirect-bridge';

broadcastResponseToMainFrame().catch((error: unknown) => {
  console.error('Microsoft sign-in callback failed', error instanceof Error ? error.name : 'Unknown');
  const status = document.getElementById('status');
  if (status) status.textContent = 'Sign-in could not be completed. Close this window and try signing in again from Admissions.';
});
