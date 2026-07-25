// ======== Cookie 工具（v5.5.6 产品化）========
//
// 用于 httpOnly Cookie 认证：
//   - 签名/验证 cookie 值，防止客户端篡改
//   - 解析请求中的 cookie
//   - 生成 Set-Cookie header
//
// 签名算法：HMAC-SHA256(value + '|' + expires)

import * as crypto from 'crypto';
import { loadOrCreateSecret } from './auth.js';

const COOKIE_SIG_LEN = 32;

function signValue(value: string): string {
  const secret = loadOrCreateSecret();
  const sig = crypto.createHmac('sha256', secret).update(value).digest('hex').slice(0, COOKIE_SIG_LEN);
  return `${value}.${sig}`;
}

function unsignValue(signed: string): string | null {
  const lastDot = signed.lastIndexOf('.');
  if (lastDot < 0) return null;
  const value = signed.slice(0, lastDot);
  const sig = signed.slice(lastDot + 1);
  const expected = signValue(value).slice(lastDot + 1);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return value;
}

export function parseCookies(header?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name) continue;
    result[decodeURIComponent(name)] = rest.length > 0 ? decodeURIComponent(rest.join('=')) : '';
  }
  return result;
}

export function getSignedCookie(req: { headers: { cookie?: string } }, name: string): string | null {
  const cookies = parseCookies(req.headers.cookie);
  const signed = cookies[name];
  if (!signed) return null;
  return unsignValue(signed);
}

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  maxAge?: number; // seconds
  expires?: Date;
  path?: string;
}

export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const signed = signValue(value);
  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(signed)}`;
  if (opts.httpOnly) cookie += '; HttpOnly';
  if (opts.secure) cookie += '; Secure';
  if (opts.sameSite) cookie += `; SameSite=${opts.sameSite.charAt(0).toUpperCase() + opts.sameSite.slice(1)}`;
  if (opts.maxAge !== undefined) cookie += `; Max-Age=${opts.maxAge}`;
  if (opts.expires) cookie += `; Expires=${opts.expires.toUTCString()}`;
  if (opts.path) cookie += `; Path=${opts.path}`;
  return cookie;
}

export function clearCookie(
  name: string,
  opts: { path?: string; secure?: boolean; sameSite?: 'strict' | 'lax' | 'none' } = {}
): string {
  let cookie = `${encodeURIComponent(name)}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0`;
  if (opts.path) cookie += `; Path=${opts.path}`;
  if (opts.secure) cookie += '; Secure';
  if (opts.sameSite) cookie += `; SameSite=${opts.sameSite.charAt(0).toUpperCase() + opts.sameSite.slice(1)}`;
  return cookie;
}

export function generateCsrfToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}
