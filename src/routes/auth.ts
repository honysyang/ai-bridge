// ======== 认证路由（v5.4.0 新增）========
//
// POST /api/auth/login     { username, password }  → { token, expiresAt, user }
// POST /api/auth/logout                              → { success: true }（客户端删 token）
// GET  /api/auth/me                                  → { user }
// POST /api/auth/refresh   { token }                 → { token, expiresAt }
// POST /api/auth/register  { username, password }    → { user }（admin only）
// GET  /api/auth/users                               → { users: [...] }（admin only）
// POST /api/auth/wechat    { wxid, nickname }        → { user }（自动 provision，首次微信消息触发）
//
// 设计要点：
//   - 登录失败统一返回「用户名或密码错误」（不暴露用户名是否存在）
//   - 密码强度校验（最少 8 位 + 字母 + 数字）
//   - token 默认 7 天有效，客户端可在 1 天阈值时续签
//   - 注册端点只允许 admin 调用（避免开放注册被滥用）

import { Router } from 'express';
import { users, isPasswordStrong, verifyPassword } from '../lib/users.js';
import { signToken, verifyToken, refreshToken } from '../lib/auth.js';
import { requireAuth, requireRole, optionalAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/error.js';
import { taskQueue } from '../task-queue.js';
import { serializeCookie, clearCookie, generateCsrfToken, getSignedCookie } from '../lib/cookies.js';
import { recordFailedAttempt, recordSuccessfulAttempt, isLockedOut } from '../lib/rate-limit.js';
import { writeAudit } from '../lib/audit.js';

// Cookie 配置
const ACCESS_COOKIE = 'aibridge_access_token';
const CSRF_COOKIE = 'aibridge_csrf';
const TOKEN_TTL_SEC = 7 * 24 * 3600;
const IS_SECURE_COOKIE =
  process.env.AIBRIDGE_COOKIE_SECURE === '1' ||
  (process.env.NODE_ENV === 'production' && process.env.AIBRIDGE_COOKIE_SECURE !== '0');
const SAME_SITE = (process.env.AIBRIDGE_COOKIE_SAME_SITE as 'strict' | 'lax' | 'none' | undefined) || 'lax';

function setAuthCookies(res: any, token: string, csrf: string): void {
  const common = { path: '/', secure: IS_SECURE_COOKIE, sameSite: SAME_SITE };
  res.append('Set-Cookie', serializeCookie(ACCESS_COOKIE, token, { ...common, httpOnly: true, maxAge: TOKEN_TTL_SEC }));
  res.append('Set-Cookie', serializeCookie(CSRF_COOKIE, csrf, { ...common, httpOnly: false, maxAge: TOKEN_TTL_SEC }));
}

function clearAuthCookies(res: any): void {
  const common = { path: '/', secure: IS_SECURE_COOKIE, sameSite: SAME_SITE };
  res.append('Set-Cookie', clearCookie(ACCESS_COOKIE, common));
  res.append('Set-Cookie', clearCookie(CSRF_COOKIE, common));
}

export const authRouter = Router();

// 公开端点
authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: '请输入用户名和密码' });
    }

    const ip = req.ip || req.socket.remoteAddress || 'unknown';

    // 登录失败锁定检查
    const lockout = isLockedOut(ip, username);
    if (lockout.locked && lockout.lockedUntil) {
      const minutes = Math.ceil((lockout.lockedUntil - Date.now()) / 60000);
      writeAudit({ action: 'auth:login:failed', actor: { username }, ip, detail: `账户已锁定，剩余 ${minutes} 分钟` });
      return res.status(429).json({ success: false, error: `登录尝试过多，请 ${minutes} 分钟后再试` });
    }

    const user = users.findByUsername(username);
    // 始终执行一次 hash 比对（即使用户不存在）以防时序攻击
    const fakeHash =
      'pbkdf2$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';
    const ok = verifyPassword(password, user ? user.password_hash : fakeHash);

    if (!user || !ok || user.disabled) {
      const result = recordFailedAttempt(ip, username);
      taskQueue.addLog('warn', 'auth', `登录失败: username=${username} ip=${ip}`);
      writeAudit({
        action: 'auth:login:failed',
        actor: user ? { id: user.id, username: user.username } : { username },
        ip,
        detail: `剩余尝试次数: ${result.locked ? 0 : (isLockedOut(ip, username).remaining ?? 0)}`
      });
      if (result.locked && result.lockedUntil) {
        const minutes = Math.ceil((result.lockedUntil - Date.now()) / 60000);
        return res.status(429).json({ success: false, error: `登录尝试过多，请 ${minutes} 分钟后再试` });
      }
      return res.status(401).json({ success: false, error: '用户名或密码错误' });
    }

    recordSuccessfulAttempt(ip, username);
    const { token, expiresAt } = signToken(user);
    const csrf = generateCsrfToken();
    setAuthCookies(res, token, csrf);
    users.recordLogin(user.id);
    taskQueue.addLog('success', 'auth', `登录成功: ${user.username} (${user.role})`);
    writeAudit({ action: 'auth:login:success', actor: { id: user.id, username: user.username, role: user.role }, ip });
    res.json({
      success: true,
      data: {
        csrf,
        expiresAt,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          display_name: user.display_name,
          wechat_wxid: user.wechat_wxid
        }
      }
    });
  })
);

// /api/auth/me: 用于前端查询当前登录用户；未登录返回 {user: null}
// 使用 optionalAuth 而不是 requireAuth，本地访问未传 token 时也能正常返回 null
// v5.5.6: 返回 token 过期时间，便于前端做续签提示
authRouter.get(
  '/me',
  optionalAuth,
  asyncHandler(async (req, res) => {
    const u = req.user;
    if (!u) {
      return res.json({ success: true, data: null });
    }
    const token = getSignedCookie(req, ACCESS_COOKIE);
    let expiresAt: number | null = null;
    if (token) {
      const verified = verifyToken(token);
      if (verified) {
        expiresAt = verified.payload.exp * 1000;
      }
    }
    res.json({
      success: true,
      data: {
        id: u.id,
        username: u.username,
        role: u.role,
        display_name: u.display_name,
        wechat_wxid: u.wechat_wxid,
        created_at: u.created_at,
        last_login_at: u.last_login_at,
        session: {
          expires_at: expiresAt,
          refresh_threshold_ms: 24 * 3600 * 1000 // 小于 1 天建议续签
        }
      }
    });
  })
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = getSignedCookie(req, ACCESS_COOKIE);
    if (!token) return res.status(401).json({ success: false, error: '未登录' });
    const result = refreshToken(token);
    if (!result) {
      clearAuthCookies(res);
      return res.status(401).json({ success: false, error: 'token 无效或已过期' });
    }
    const csrf = generateCsrfToken();
    setAuthCookies(res, result.token, csrf);
    res.json({ success: true, data: { csrf, expiresAt: result.expiresAt } });
  })
);

authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    taskQueue.addLog('info', 'auth', `登出: ${req.user!.username}`);
    writeAudit({
      action: 'auth:logout',
      actor: { id: req.user!.id, username: req.user!.username, role: req.user!.role },
      ip
    });
    clearAuthCookies(res);
    res.json({ success: true });
  })
);

// 当前用户修改密码（无需 admin，任何已登录用户均可）
authRouter.post(
  '/me/password',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ success: false, error: '请输入原密码和新密码' });
    }
    try {
      users.updatePassword(req.user!.id, { oldPassword, newPassword });
      taskQueue.addLog('success', 'auth', `用户 ${req.user!.username} 修改密码`);
      writeAudit({
        action: 'auth:password:changed',
        actor: { id: req.user!.id, username: req.user!.username, role: req.user!.role },
        ip
      });
      res.json({ success: true });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  })
);

// ===== 管理员端点 =====

authRouter.post(
  '/register',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { username, password, role, display_name } = req.body || {};
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    try {
      const u = users.create({ username, password, role, display_name });
      taskQueue.addLog('success', 'auth', `注册新用户: ${u.username} (${u.role}) by ${req.user!.username}`);
      writeAudit({
        action: 'user:create',
        actor: { id: req.user!.id, username: req.user!.username, role: req.user!.role },
        ip,
        target: u.id,
        after: { username: u.username, role: u.role, display_name: u.display_name }
      });
      res.json({
        success: true,
        data: {
          id: u.id,
          username: u.username,
          role: u.role,
          display_name: u.display_name
        }
      });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  })
);

authRouter.get(
  '/users',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (_req, res) => {
    const list = users.list().map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      display_name: u.display_name,
      wechat_wxid: u.wechat_wxid,
      created_at: u.created_at,
      last_login_at: u.last_login_at,
      disabled: u.disabled || false
    }));
    res.json({ success: true, data: list });
  })
);

authRouter.patch(
  '/users/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { role, display_name, disabled } = req.body || {};
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    try {
      const before = users.findById(id);
      const u = users.update(id, { role, display_name, disabled });
      taskQueue.addLog(
        'success',
        'auth',
        `管理员更新用户: ${u.username} (${u.role}, disabled=${u.disabled}) by ${req.user!.username}`
      );
      writeAudit({
        action: 'user:update',
        actor: { id: req.user!.id, username: req.user!.username, role: req.user!.role },
        ip,
        target: id,
        before: before
          ? { role: before.role, display_name: before.display_name, disabled: before.disabled }
          : undefined,
        after: { role: u.role, display_name: u.display_name, disabled: u.disabled }
      });
      res.json({
        success: true,
        data: {
          id: u.id,
          username: u.username,
          role: u.role,
          display_name: u.display_name,
          disabled: u.disabled || false
        }
      });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  })
);

authRouter.delete(
  '/users/:id',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (req.user!.id === id) {
      return res.status(400).json({ success: false, error: '不能删除当前登录用户' });
    }
    try {
      const before = users.findById(id);
      users.delete(id);
      taskQueue.addLog('success', 'auth', `管理员删除用户 id=${id} by ${req.user!.username}`);
      writeAudit({
        action: 'user:delete',
        actor: { id: req.user!.id, username: req.user!.username, role: req.user!.role },
        ip,
        target: id,
        before: before ? { username: before.username, role: before.role } : undefined
      });
      res.json({ success: true });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  })
);

authRouter.post(
  '/users/:id/reset-password',
  requireAuth,
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { password } = req.body || {};
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    try {
      const { user: u, password: finalPassword } = users.resetPassword(id, password);
      taskQueue.addLog('success', 'auth', `管理员重置用户 ${u.username} 密码 by ${req.user!.username}`);
      writeAudit({
        action: 'auth:password:reset',
        actor: { id: req.user!.id, username: req.user!.username, role: req.user!.role },
        ip,
        target: id
      });
      res.json({
        success: true,
        data: {
          id: u.id,
          username: u.username,
          password: finalPassword
        }
      });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  })
);

// 返回当前 CSRF token（用于前端初始化或 csrf cookie 丢失时）
authRouter.get(
  '/csrf',
  optionalAuth,
  asyncHandler(async (_req, res) => {
    const csrf = generateCsrfToken();
    res.append(
      'Set-Cookie',
      serializeCookie(CSRF_COOKIE, csrf, {
        path: '/',
        secure: IS_SECURE_COOKIE,
        sameSite: SAME_SITE,
        httpOnly: false,
        maxAge: TOKEN_TTL_SEC
      })
    );
    res.json({ success: true, data: { csrf } });
  })
);

// 微信用户自动 provision（不需要登录，adapter 在收到第一条消息时调用）
authRouter.post(
  '/wechat',
  asyncHandler(async (req, res) => {
    const { wxid, nickname } = req.body || {};
    if (!wxid) return res.status(400).json({ success: false, error: '缺少 wxid' });
    const u = users.provisionWechatUser(wxid, nickname);
    res.json({
      success: true,
      data: {
        id: u.id,
        username: u.username,
        role: u.role,
        display_name: u.display_name,
        wechat_wxid: u.wechat_wxid
      }
    });
  })
);
