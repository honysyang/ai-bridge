// ======== 认证（v5.4.0 新增）========
//
// Token 设计：HMAC-SHA256 签名
//   payload 格式：base64url({sub, username, role, iat, exp})
//   token 格式：<payload>.<signature>
//   签名密钥：从 secrets.env 的 AIBRIDGE_JWT_SECRET 读，缺省自动生成并持久化
//
// 公共 API：
//   auth.signToken(user)            → { token, expiresAt }
//   auth.verifyToken(token)         → { user, payload } | null
//   auth.refreshToken(oldToken)     → { token, expiresAt } | null
//
// 安全考虑：
//   - 默认 7 天过期，refreshToken 滑动续签
//   - 签名密钥只在服务启动时生成一次（重启后旧 token 失效，所有人需重新登录）
//   - 浏览器存储：localStorage（demo 用），生产建议 httpOnly cookie

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { childLogger } from './logger.js';
import { users, type User, type UserRole } from './users.js';
import { SECRETS_FILE } from './paths.js';

const log = childLogger({ module: 'auth' });

const DEFAULT_TTL_SEC = 7 * 24 * 3600; // 7 天
const REFRESH_THRESHOLD_SEC = 24 * 3600; // 剩余 < 1 天时允许续签

let SECRET: Buffer | null = null;

export function loadOrCreateSecret(): Buffer {
  if (SECRET) return SECRET;

  // 1) 优先从环境变量读
  const envSecret = process.env.AIBRIDGE_JWT_SECRET;
  if (envSecret && envSecret.length >= 32) {
    SECRET = Buffer.from(envSecret, 'utf-8');
    log.info('使用环境变量 AIBRIDGE_JWT_SECRET');
    return SECRET;
  }

  // 2) 从 secrets.env 文件读
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      const content = fs.readFileSync(SECRETS_FILE, 'utf-8');
      const m = /^AIBRIDGE_JWT_SECRET=(.+)$/m.exec(content);
      if (m && m[1].trim().length >= 32) {
        SECRET = Buffer.from(m[1].trim(), 'utf-8');
        log.info('从 secrets.env 读取 JWT 密钥');
        return SECRET;
      }
    }
  } catch (e: any) {
    log.warn(`读取 secrets.env 失败: ${e.message}`);
  }

  // 3) 自动生成并写入 secrets.env
  const newSecret = crypto.randomBytes(48).toString('base64url');
  try {
    const secretsDir = path.dirname(SECRETS_FILE);
    if (!fs.existsSync(secretsDir)) {
      fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    }
    const line = `\n# JWT 签名密钥（自动生成，${new Date().toISOString()}）\nAIBRIDGE_JWT_SECRET=${newSecret}\n`;
    fs.appendFileSync(SECRETS_FILE, line, { mode: 0o600 });
    log.info(`JWT 密钥已生成并写入 secrets.env（chmod 600）`);
  } catch (e: any) {
    log.warn(`无法写入 secrets.env: ${e.message}，密钥仅存在于内存（重启后失效）`);
  }
  SECRET = Buffer.from(newSecret, 'utf-8');
  return SECRET;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function sign(payload: string): string {
  return b64url(crypto.createHmac('sha256', loadOrCreateSecret()).update(payload).digest());
}

export interface AuthPayload {
  sub: string; // user id
  username: string;
  role: string;
  iat: number; // issued at (sec)
  exp: number; // expires at (sec)
}

export interface AuthResult {
  user: User;
  payload: AuthPayload;
}

export function signToken(
  user: User,
  ttlSec = DEFAULT_TTL_SEC
): { token: string; expiresAt: number; payload: AuthPayload } {
  const now = Math.floor(Date.now() / 1000);
  const payload: AuthPayload = {
    sub: user.id,
    username: user.username,
    role: user.role,
    iat: now,
    exp: now + ttlSec
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf-8'));
  const sig = sign(payloadB64);
  return {
    token: `${payloadB64}.${sig}`,
    expiresAt: payload.exp * 1000,
    payload
  };
}

export function verifyToken(token: string): AuthResult | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = sign(payloadB64);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  let payload: AuthPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf-8'));
  } catch {
    return null;
  }
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }
  const user = users.findById(payload.sub);
  if (!user || user.disabled) return null;
  return { user, payload };
}

export function refreshToken(token: string): { token: string; expiresAt: number } | null {
  const result = verifyToken(token);
  if (!result) return null;
  const now = Math.floor(Date.now() / 1000);
  if (result.payload.exp - now > REFRESH_THRESHOLD_SEC) {
    // 剩余 > 1 天，不续签（避免无意义重发）
    return { token, expiresAt: result.payload.exp * 1000 };
  }
  const fresh = signToken(result.user);
  return { token: fresh.token, expiresAt: fresh.expiresAt };
}

/**
 * 角色等级（用于权限比较）
 */
export const ROLE_RANK: Record<string, number> = {
  admin: 100,
  operator: 50,
  viewer: 10
};

export function hasRole(user: User, minRole: UserRole): boolean {
  return (ROLE_RANK[user.role] || 0) >= (ROLE_RANK[minRole] || 0);
}
