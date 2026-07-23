import { Router } from 'express';
import { sessionManager } from '../session.js';
import { taskQueue } from '../task-queue.js';
import { SessionStatus } from '../types.js';
import { asyncHandler } from '../middleware/error.js';

/**
 * 会话管理路由
 * - GET    /api/sessions         列出/搜索
 * - POST   /api/sessions         创建
 * - GET    /api/sessions/:id     详情
 * - PATCH  /api/sessions/:id     更新
 * - DELETE /api/sessions/:id     删除（任务重新归属默认）
 * - GET    /api/sessions/:id/tasks  会话内任务
 */
export const sessionRouter = Router();

// 列出（支持 status 过滤 + q 搜索）
sessionRouter.get('/', asyncHandler((req, res) => {
  const status = req.query.status as SessionStatus | undefined;
  const q = req.query.q as string | undefined;
  const sessions = sessionManager.listSessions({ status, q });
  res.json({
    success: true,
    data: sessions,
    meta: { total: sessions.length, default_session_id: sessionManager.getDefaultSessionId() }
  });
}));

// 创建
sessionRouter.post('/', asyncHandler((req, res) => {
  const { name, description, meta } = req.body || {};
  const session = sessionManager.createSession({ name, description, meta });
  taskQueue.addLog('info', 'task', `会话创建: ${session.id} (${session.name})`, { session_id: session.id });
  res.json({ success: true, data: session });
}));

// 详情
sessionRouter.get('/:id', asyncHandler((req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: '会话不存在' });
  }
  res.json({ success: true, data: session });
}));

// 更新
sessionRouter.patch('/:id', asyncHandler((req, res) => {
  const updated = sessionManager.updateSession(req.params.id, req.body || {});
  if (!updated) {
    return res.status(404).json({ success: false, error: '会话不存在' });
  }
  taskQueue.addLog('info', 'task', `会话更新: ${updated.id} (${updated.name})`, { session_id: updated.id });
  res.json({ success: true, data: updated });
}));

// 删除（任务重新归属默认会话）
sessionRouter.delete('/:id', asyncHandler((req, res) => {
  const result = sessionManager.deleteSession(req.params.id);
  if (!result.ok) {
    return res.status(404).json({ success: false, error: '会话不存在' });
  }
  taskQueue.addLog(
    'warn',
    'task',
    `会话删除: ${req.params.id}，${result.reassigned_tasks} 个任务已重新归属默认会话`,
    { session_id: req.params.id }
  );
  res.json({ success: true, message: '已删除', data: result });
}));

// 会话内任务列表
sessionRouter.get('/:id/tasks', asyncHandler((req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: '会话不存在' });
  }
  const tasks = sessionManager.getSessionTasks(req.params.id, limit);
  res.json({
    success: true,
    data: tasks,
    meta: { session_id: req.params.id, total: tasks.length }
  });
}));
