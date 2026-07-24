// ======== 认证中间件（v5.4.0 新增）========
//
// 行为：
//   - 解析 Authorization: Bearer <token> header
//   - 验证通过后挂载到 req.user
//   - 失败时（无 token / 无效 / 过期）返回 401
//   - 本地 127.0.0.1 / ::1 访问自动放行（开发友好）
//
// 可选参数：
//   requireRole('admin')   - 要求至少为 admin 角色
//   optionalAuth()          - 不强制要求登录（只挂载 user）

import { Request, Response, NextFunction } from 'express';
import { verifyToken, hasRole } from '../lib/auth.js';
import { type User, type UserRole } from '../lib/users.js';

// 扩展 Express Request 类型
declare global {
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
  '/api/system/version'  // v5.5.1: 公开版本号（login 页需要）
];
// - 正则匹配的路径（如 /api/task/<id>/retry）
const PUBLIC_API_PATTERNS = [
  /^\/api\/task\/[^/]+\/retry$/
];

function isLocalRequest(req: Request): boolean {
  const ip = req.ip || req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isPublicPath(req: Request): boolean {
  // 使用 originalUrl 确保包含 /api 前缀（req.path 在 app.use('/api', ...) 挂载时会被剥离）
  const fullPath = (req.originalUrl || req.url || '').split('?')[0];
  if (PUBLIC_API_PATHS.some(p => fullPath === p || fullPath.startsWith(p + '/'))) {
    return true;
  }
  return PUBLIC_API_PATTERNS.some(re => re.test(fullPath));
}

/**
 * 强制认证：失败返回 401
 * - 本地访问（127.0.0.1）免登录
 * - 公开端点（白名单）免登录
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // 本地访问免登录
  if (isLocalRequest(req)) {
    // 尝试用 token 解析（如果有）
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) {
      const result = verifyToken(auth.slice(7));
      if (result) req.user = result.user;
    }
    return next();
  }

  // 公开端点免登录
  if (isPublicPath(req)) {
    return next();
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: '未授权：缺少 Authorization header' });
  }
  const result = verifyToken(auth.slice(7));
  if (!result) {
    return res.status(401).json({ success: false, error: '未授权：token 无效或已过期' });
  }
  req.user = result.user;
  next();
}

/**
 * 可选认证：解析 token 但不强制
 */
export function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    const result = verifyToken(auth.slice(7));
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
