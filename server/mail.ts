import { ClientSecretCredential } from '@azure/identity';
import { config } from './config.js';
import * as db from './db.js';
import { HttpError, logger } from './errors.js';

const credential = config.emailEnabled
  ? new ClientSecretCredential(config.GRAPH_TENANT_ID!, config.GRAPH_CLIENT_ID!, config.GRAPH_CLIENT_SECRET!) : null;
export function mailContent(kind: string, token: string | null) {
  if (kind === 'confirmation') {
    if (!token) throw new Error('Confirmation email has no token.');
    return {
      subject: 'Confirm Admissions email updates',
      text: `Confirm that you want email updates about your admissions request. This link expires in 24 hours:\n\n${config.PUBLIC_BASE_URL}/confirm#${token}\n\nIf you did not request this, ignore this email. Confirming does not provide access to request details. Keep the tracking code you received on the site.`,
    };
  }
  return {
    subject: 'Your Admissions request has an update',
    text: `There is an update to your admissions request. Visit ${config.PUBLIC_BASE_URL}/track and enter the private tracking code you saved when submitting your request.\n\nYou can turn off email updates on the tracking page. No request details are included in this email.`,
  };
}
async function send(job: db.MailJob) {
  if (!credential) throw new Error('Email delivery is not configured.');
  const token = await credential.getToken('https://graph.microsoft.com/.default', { abortSignal: AbortSignal.timeout(15000) });
  if (!token) throw new Error('Microsoft Graph did not issue an access token.');
  const content = mailContent(job.kind, job.token);
  const response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.MAIL_FROM_ADDRESS!)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { subject: content.subject, body: { contentType: 'Text', content: content.text },
        toRecipients: [{ emailAddress: { address: job.email } }] },
      saveToSentItems: false,
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new HttpError(response.status, 'Microsoft Graph rejected email delivery.', 'GRAPH_SEND_FAILED');
}
export function startMailWorker() {
  let stopping = false;
  let running: Promise<void> | null = null;
  const tick = async () => {
    try {
      for (let i = 0; i < 10 && !stopping; i++) {
        const job = await db.claimMail();
        if (!job) break;
        try {
          await send(job);
          await db.completeMail(job);
        } catch (error) {
          logger.error({
            jobId: job.id, attempt: job.attempts, errorType: error instanceof Error ? error.name : 'Unknown',
            ...(error instanceof HttpError ? { code: error.code, httpStatus: error.status } : {}),
          }, 'Admissions email delivery failed; retry queued or exhausted');
          await db.failMail(job);
        }
      }
    } catch (error) { logger.error({ err: error }, 'Admissions email worker failed'); }
  };
  const timer = setInterval(() => {
    if (!running && config.emailEnabled) running = tick().finally(() => { running = null; });
  }, 5000);
  return async () => { stopping = true; clearInterval(timer); await running; };
}
