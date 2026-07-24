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

export const authRouter = Router();

// 公开端点
authRouter.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, error: '请输入用户名和密码' });
  }
  const user = users.findByUsername(username);
  // 始终执行一次 hash 比对（即使用户不存在）以防时序攻击
  const fakeHash = 'pbkdf2$100000$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';
  const ok = verifyPassword(password, user ? user.password_hash : fakeHash);

  if (!user || !ok || user.disabled) {
    taskQueue.addLog('warn', 'auth', `登录失败: username=${username} ip=${req.ip}`);
    return res.status(401).json({ success: false, error: '用户名或密码错误' });
  }
  const { token, expiresAt, payload } = signToken(user);
  users.recordLogin(user.id);
  taskQueue.addLog('success', 'auth', `登录成功: ${user.username} (${user.role})`);
  res.json({
    success: true,
    data: {
      token,
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
}));

// /api/auth/me: 用于前端查询当前登录用户；未登录返回 {user: null}
// 使用 optionalAuth 而不是 requireAuth，本地访问未传 token 时也能正常返回 null
authRouter.get('/me', optionalAuth, asyncHandler(async (req, res) => {
  const u = req.user;
  if (!u) {
    return res.json({ success: true, data: null });
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
      last_login_at: u.last_login_at
    }
  });
}));

authRouter.post('/refresh', asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: '缺少 token' });
  const result = refreshToken(token);
  if (!result) {
    return res.status(401).json({ success: false, error: 'token 无效或已过期' });
  }
  res.json({ success: true, data: result });
}));

authRouter.post('/logout', requireAuth, asyncHandler(async (req, res) => {
  taskQueue.addLog('info', 'auth', `登出: ${req.user!.username}`);
  res.json({ success: true });
}));

// ===== 管理员端点 =====

authRouter.post('/register', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  const { username, password, role, display_name } = req.body || {};
  try {
    const u = users.create({ username, password, role, display_name });
    taskQueue.addLog('success', 'auth', `注册新用户: ${u.username} (${u.role}) by ${req.user!.username}`);
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
}));

authRouter.get('/users', requireAuth, requireRole('admin'), asyncHandler(async (_req, res) => {
  const list = users.list().map(u => ({
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
}));

authRouter.patch('/users/:id', requireAuth, requireRole('admin'), asyncHandler(async (req, res) => {
  // TODO: 暂只支持 disabled 切换；后续扩展
  res.status(501).json({ success: false, error: '暂未实现' });
}));

// 微信用户自动 provision（不需要登录，adapter 在收到第一条消息时调用）
authRouter.post('/wechat', asyncHandler(async (req, res) => {
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
}));
