import { createApp } from './app.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { logger } from './errors.js';
import { startMailWorker } from './mail.js';

try {
  await pool.connect();
  await migrate();
  const stopMail = startMailWorker();
  const server = createApp().listen(config.PORT, () => logger.info({ port: config.PORT }, 'Admissions is ready'));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => { logger.fatal('Graceful shutdown timed out'); process.exit(1); }, 45000);
    timeout.unref();
    try {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await stopMail();
      await pool.close();
      clearTimeout(timeout);
    } catch (error) { logger.fatal({ err: error }, 'Shutdown failed'); process.exitCode = 1; }
  };
  process.on('SIGTERM', () => { void shutdown(); });
  process.on('SIGINT', () => { void shutdown(); });
} catch (error) {
  logger.fatal({ err: error }, 'Admissions could not start');
  await pool.close();
  process.exitCode = 1;
}
