import { createHash, randomBytes } from 'node:crypto';

export const newSecret = () => randomBytes(24).toString('base64url');
export const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');
