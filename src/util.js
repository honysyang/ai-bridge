import crypto from 'node:crypto';

export function uid(prefix = 'id') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;
}

export function now() {
  return Math.floor(Date.now() / 1000);
}
