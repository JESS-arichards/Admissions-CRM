import { logger } from './errors.js';

const transientNumbers = new Set([40613, 40197, 40501, 10928, 10929, 49918, 49919, 49920, 42108, 42109]);
const transientCodes = new Set(['ETIMEOUT', 'ESOCKET', 'ECONNCLOSED', 'ENOTOPEN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH']);

function property(value: object, key: string): unknown {
  try { return Reflect.get(value, key); } catch { return undefined; }
}

function sqlErrorSummary(error: unknown) {
  if (!error || typeof error !== 'object') return {};
  const number = property(error, 'number'), code = property(error, 'code');
  return {
    sqlNumber: typeof number === 'number' && Number.isSafeInteger(number) ? number : undefined,
    sqlCode: typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,30}$/.test(code) ? code : undefined,
  };
}

export function isTransientSqlError(error: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (!error || typeof error !== 'object' || seen.has(error) || depth > 8) return false;
  seen.add(error);
  const number = property(error, 'number'), code = property(error, 'code');
  if ((typeof number === 'number' && transientNumbers.has(number)) || (typeof code === 'string' && transientCodes.has(code))) return true;
  const nested = [property(error, 'originalError'), property(error, 'cause'), property(error, 'info')];
  const preceding = property(error, 'precedingErrors');
  if (Array.isArray(preceding)) nested.push(...preceding.slice(0, 20));
  return nested.some((item) => isTransientSqlError(item, seen, depth + 1));
}

export interface WakeConnection {
  connect(): Promise<unknown>;
  config: { connectionTimeout?: number; options?: { connectTimeout?: number } };
}

// Only retry connection establishment, never migrations, queries or uncertain writes.
export async function connectWithWakeRetry(pool: WakeConnection, shouldStop: () => boolean = () => false) {
  const deadline = Date.now() + 90000;
  let backoff = 1000;
  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - Date.now();
    pool.config.connectionTimeout = Math.max(1, Math.min(10000, remaining));
    pool.config.options = { ...pool.config.options, connectTimeout: pool.config.connectionTimeout };
    try {
      logger.info({ attempt, timeoutMs: pool.config.connectionTimeout }, 'Connecting to Admissions SQL');
      await pool.connect();
      logger.info({ attempt }, 'Admissions SQL connection established');
      return;
    } catch (error) {
      if (shouldStop()) {
        logger.info({ attempt }, 'Admissions SQL startup connection cancelled by shutdown');
        throw error;
      }
      const timeLeft = deadline - Date.now();
      const transient = isTransientSqlError(error);
      if (!transient || timeLeft <= 0) {
        logger.error({ attempt, transient, ...sqlErrorSummary(error) }, 'Admissions SQL startup connection failed; not retrying');
        throw error;
      }
      const retryInMs = Math.min(backoff, timeLeft);
      logger.warn({ attempt, retryInMs, ...sqlErrorSummary(error) }, 'Admissions SQL is unavailable or resuming; retrying connection');
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
      if (shouldStop()) {
        logger.info({ attempt }, 'Admissions SQL startup connection cancelled by shutdown');
        throw error;
      }
      if (Date.now() >= deadline) {
        logger.error({ attempt }, 'Admissions SQL wake retry window exhausted');
        throw error;
      }
      backoff = Math.min(backoff * 2, 10000);
    } finally {
      pool.config.connectionTimeout = 10000;
      pool.config.options = { ...pool.config.options, connectTimeout: 10000 };
    }
  }
}
