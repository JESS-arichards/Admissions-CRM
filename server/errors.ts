import pino from 'pino';
import { config } from './config.js';

export const logger = pino({ level: config.LOG_LEVEL });
export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_FAILED') { super(message); }
}
