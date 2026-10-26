import type { NextFunction, Request, Response } from 'express';
import { SignJWT, jwtVerify } from 'jose';
import { canAdminister, canWork, type CentralUser } from '../shared/contracts.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { centralUser } from './platform.js';

declare global {
  namespace Express { interface Request { user?: CentralUser } }
}
const key = new TextEncoder().encode(config.SESSION_SECRET);
export const cookieName = 'admissions_session';
export const cookieOptions = { httpOnly: true, secure: config.NODE_ENV === 'production', sameSite: 'strict' as const, path: '/' };
export async function sessionToken(user: CentralUser) {
  return new SignJWT({ sv: user.sessionVersion }).setProtectedHeader({ alg: 'HS256' })
    .setIssuer('jess-admissions').setAudience('admissions-staff').setSubject(String(user.id))
    .setIssuedAt().setExpirationTime('8h').sign(key);
}
export async function authenticated(req: Request, _res: Response, next: NextFunction) {
  const token: unknown = req.cookies?.[cookieName];
  if (typeof token !== 'string') throw new HttpError(401, 'Staff sign-in required.');
  let id: number;
  let version: number;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'], issuer: 'jess-admissions', audience: 'admissions-staff' });
    id = Number(payload.sub);
    if (!Number.isSafeInteger(id) || id < 1 || typeof payload.sv !== 'number') throw new Error('Invalid session claims.');
    version = payload.sv;
  } catch {
    throw new HttpError(401, 'Your session has expired. Sign in again.');
  }
  const user = await centralUser(id);
  if (!user.isActive || user.sessionVersion !== version) throw new HttpError(401, 'Your access has changed. Sign in again.');
  if (!canWork(user)) throw new HttpError(403, 'An Admissions role is required. Contact your portal administrator.');
  req.user = user;
  next();
}
export function administrator(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || !canAdminister(req.user)) throw new HttpError(403, 'Admissions administration permission is required.');
  next();
}
