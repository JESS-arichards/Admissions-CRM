import { createApp } from './app.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { logger } from './errors.js';
import { startMailWorker } from './mail.js';
import { connectWithWakeRetry } from './sqlServerless.js';
import type { Server } from 'node:http';

let server: Server | undefined;
let stopMail: (() => Promise<void>) | undefined;
let closing = false;
let shutdownRegistered = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  const timeout = setTimeout(() => { logger.fatal('Graceful shutdown timed out'); process.exit(1); }, 45000);
  timeout.unref();
  try {
    const listeningServer = server;
    if (listeningServer) await new Promise<void>((resolve, reject) => listeningServer.close((error) => error ? reject(error) : resolve()));
    await stopMail?.();
    await pool.close();
    clearTimeout(timeout);
  } catch (error) { logger.fatal({ err: error }, 'Shutdown failed'); process.exitCode = 1; }
};
const registerShutdown = () => {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
};
try {
  let ready = false;
  if (config.SQL_SERVERLESS_ENABLED) {
    server = createApp(() => ready).listen(config.PORT, () => logger.info({ port: config.PORT }, 'Admissions is initializing'));
    // Serverless warm-up can take about 90 seconds, so honour platform stop signals during it.
    registerShutdown();
    await connectWithWakeRetry(pool, () => closing);
  } else {
    await pool.connect();
  }
  if (!closing) await migrate();
  if (!closing) {
    ready = true;
    if (config.SQL_SERVERLESS_ENABLED) logger.info('Admissions is ready');
    stopMail = startMailWorker();
    server ??= createApp().listen(config.PORT, () => logger.info({ port: config.PORT }, 'Admissions is ready'));
    registerShutdown();
  }
} catch (error) {
  if (closing) logger.info('Admissions startup stopped during shutdown');
  else {
    logger.fatal({ err: error }, 'Admissions could not start');
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await pool.close();
    process.exitCode = 1;
  }
}