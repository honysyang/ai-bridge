// ======== 认证中间件（v5.5.6 产品化重构）========
//
// 行为：
//   - 解析 Authorization: Bearer <token> header
//   - 验证通过后挂载到 req.user
//   - 失败时（无 token / 无效 / 过期）返回 401
//   - 本地访问自动放行（默认 127.0.0.1 / ::1，可通过 AIBRIDGE_LOCAL_NETWORKS 扩展）
//
// 安全说明：
//   - 本地判断基于 req.socket.remoteAddress，不受 X-Forwarded-For 影响
//   - 如需在私有网段自动放行，请显式设置 AIBRIDGE_LOCAL_NETWORKS
//
// 可选参数：
//   requireRole('admin')   - 要求至少为 admin 角色
//   optionalAuth()          - 不强制要求登录（只挂载 user）

import { Request, Response, NextFunction } from 'express';
import { verifyToken, hasRole } from '../lib/auth.js';
import { type User, type UserRole } from '../lib/users.js';
import { getSignedCookie, parseCookies } from '../lib/cookies.js';

const ACCESS_COOKIE = 'aibridge_access_token';
const CSRF_COOKIE = 'aibridge_csrf';
const CSRF_HEADER = 'x-csrf-token';

// 扩展 Express Request 类型
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

// 公开端点白名单（不需要登录），其余 /api/* 全部要求认证
// - 精确匹配的路径
const PUBLIC_API_PATHS = [
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/wechat',
  '/api/heartbeat',
  '/api/task/poll',
  '/api/task/complete',
  '/api/task/stats',
  '/api/health',
  '/api/system/version', // 公开版本号（login 页需要）
  '/api/system/docs' // OpenAPI 文档公开
];
// - 正则匹配的路径（如 /api/task/<id>/retry）
const PUBLIC_API_PATTERNS = [/^\/api\/task\/[^/]+\/retry$/];

// 可通过 AIBRIDGE_LOCAL_NETWORKS 扩展本地放行网段，例如：
// AIBRIDGE_LOCAL_NETWORKS=127.0.0.1,::1,192.168.0.0/16,10.0.0.0/8
const LOCAL_NETWORKS = (process.env.AIBRIDGE_LOCAL_NETWORKS || '127.0.0.1,::1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function ipToNumber(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return 0;
  return parts.reduce((acc, p) => (acc << 8) + (parseInt(p, 10) || 0), 0) >>> 0;
}

function isInCidr(ip: string, cidr: string): boolean {
  const [network, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const ipNum = ipToNumber(ip);
  const netNum = ipToNumber(network);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

function isTrustedLocalIp(ip: string): boolean {
  if (!ip) return false;
  // 处理 IPv4-mapped IPv6
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  for (const net of LOCAL_NETWORKS) {
    if (net === v4 || net === ip) return true;
    if (net.includes('/')) {
      if (isInCidr(v4, net)) return true;
    }
  }
  return false;
}

function isLocalRequest(req: Request): boolean {
  // 使用原始 socket 地址判断，避免 X-Forwarded-For 伪造
  const ip = req.socket.remoteAddress || '';
  return isTrustedLocalIp(ip);
}

function isPublicPath(req: Request): boolean {
  // 使用 originalUrl 确保包含 /api 前缀（req.path 在 app.use('/api', ...) 挂载时会被剥离）
  const fullPath = (req.originalUrl || req.url || '').split('?')[0];
  if (PUBLIC_API_PATHS.some((p) => fullPath === p || fullPath.startsWith(p + '/'))) {
    return true;
  }
  return PUBLIC_API_PATTERNS.some((re) => re.test(fullPath));
}

function isCsrfSafeMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function validateCsrf(req: Request): boolean {
  if (isCsrfSafeMethod(req.method)) return true;
  const cookies = parseCookies(req.headers.cookie);
  const cookieCsrf = cookies[CSRF_COOKIE];
  const headerCsrf = req.headers[CSRF_HEADER] as string | undefined;
  if (!cookieCsrf || !headerCsrf) return false;
  return cookieCsrf === headerCsrf;
}

/**
 * 强制认证：失败返回 401
 * - 本地访问（AIBRIDGE_LOCAL_NETWORKS）免登录
 * - 公开端点（白名单）免登录
 * - 正常请求使用 httpOnly Cookie + CSRF Token（double submit cookie）
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // 本地访问免登录
  if (isLocalRequest(req)) {
    // 尝试用 cookie 中的 token 解析（如果有）
    const token = getSignedCookie(req, ACCESS_COOKIE);
    if (token) {
      const result = verifyToken(token);
      if (result) req.user = result.user;
    }
    return next();
  }

  // 公开端点免登录
  if (isPublicPath(req)) {
    return next();
  }

  // CSRF 校验（非安全方法）
  if (!validateCsrf(req)) {
    return res.status(403).json({ success: false, error: '禁止访问：CSRF token 无效' });
  }

  // 从 httpOnly cookie 读取 token
  const token = getSignedCookie(req, ACCESS_COOKIE);
  if (!token) {
    return res.status(401).json({ success: false, error: '未授权：请重新登录' });
  }
  const result = verifyToken(token);
  if (!result) {
    return res.status(401).json({ success: false, error: '未授权：token 无效或已过期' });
  }
  req.user = result.user;
  next();
}

/**
 * 可选认证：解析 cookie 中的 token 但不强制
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = getSignedCookie(req, ACCESS_COOKIE);
  if (token) {
    const result = verifyToken(token);
    if (result) req.user = result.user;
  }
  next();
}

/**
 * 角色要求：必须配合 requireAuth 使用
 */
export function requireRole(minRole: UserRole) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: '未授权' });
    }
    if (!hasRole(req.user, minRole)) {
      return res.status(403).json({ success: false, error: `权限不足：需要 ${minRole} 角色` });
    }
    next();
  };
}
