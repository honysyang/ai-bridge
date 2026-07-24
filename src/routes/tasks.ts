import { Router } from 'express';
import { taskQueue } from '../task-queue.js';
import { sessionManager } from '../session.js';
import { TaskSource, TaskType, TaskPriority, TaskResult, LogLevel, LogSource } from '../types.js';
import { asyncHandler } from '../middleware/error.js';

/**
 * 任务管理 + 上下文 + 日志路由（合并了原 server.ts 中散落的 /api/tasks*、/api/task/*、/api/context/*、/api/logs）
 */
export const taskRouter = Router();
export const contextRouter = Router();
export const logRouter = Router();

// ======== /api/tasks ========

// 列表（带过滤）
taskRouter.get('/', asyncHandler((req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const status = req.query.status as any;
  const type = req.query.type as any;
  const source = req.query.source as any;
  const sessionId = req.query.session_id as string | undefined;

  const tasks = taskQueue.getRecentTasks(limit, { status, type, source, session_id: sessionId } as any);
  res.json({
    success: true,
    data: tasks,
    meta: { total_count: tasks.length, queue_stats: taskQueue.getStats() }
  });
}));

// ======== /api/task/* (Trae Agent 专用) ========
// 静态路径必须在 /:id 之前注册，否则会被 :id 吞掉

// 长轮询
taskRouter.get('/poll', asyncHandler(async (req, res) => {
  const timeout = Math.min(parseInt(req.query.timeout as string) || 30000, 60000);
  const task = await taskQueue.pollTask(timeout);
  if (task) {
    res.json({ success: true, has_task: true, task });
  } else {
    res.json({ success: true, has_task: false });
  }
}));

// 队列统计
taskRouter.get('/stats', asyncHandler((_req, res) => {
  res.json({ success: true, data: taskQueue.getStats() });
}));

// 详情（放在 :id 静态路径之后）
taskRouter.get('/:id', asyncHandler((req, res) => {
  const task = taskQueue.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  res.json({ success: true, data: task });
}));

// 创建
taskRouter.post('/', asyncHandler((req, res) => {
  const {
    content,
    type = 'chat',
    priority = 'normal',
    source = 'manual',
    from_user,
    session_id
  } = req.body || {};

  if (!content || typeof content !== 'string') {
    return res.status(400).json({ success: false, error: '缺少 content 或类型错误' });
  }

  const targetSession = session_id
    ? sessionManager.getSessionOrDefault(session_id)
    : sessionManager.ensureDefaultSession();

  const taskSource: TaskSource = type === 'chat' ? 'chat' : (source as TaskSource);
  const task = taskQueue.addTask({
    type: type as TaskType,
    priority: priority as TaskPriority,
    source: taskSource,
    data: { content: content.trim(), from_user: from_user || (type === 'chat' ? 'chat-user' : 'manual-input') },
    session_id: targetSession.id
  } as any);

  sessionManager.touchSession(targetSession.id);

  res.json({ success: true, data: { ...task, session_id: targetSession.id } });
}));

// 删除
taskRouter.delete('/:id', asyncHandler((req, res) => {
  const ok = taskQueue.deleteTask(req.params.id);
  if (!ok) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  res.json({ success: true, message: '已删除' });
}));

// 重试
taskRouter.post('/:id/retry', asyncHandler((req, res) => {
  const task = taskQueue.retryTask(req.params.id);
  if (!task) {
    return res.status(400).json({ success: false, error: '任务不存在或状态不允许重试' });
  }
  res.json({ success: true, data: task, message: '任务已重新入队' });
}));

// v5.4.2: 撤回（undo）—— 把 completed/failed 任务回退到 pending，保留历史
taskRouter.post('/:id/undo', asyncHandler((req, res) => {
  const result = taskQueue.undoTask(req.params.id);
  if (!result) {
    return res.status(400).json({ success: false, error: '任务不存在或状态不允许撤回（仅 completed/failed 可撤回）' });
  }
  res.json({
    success: true,
    data: result.task,
    history_size: result.history.length,
    message: `已撤回，保留 ${result.history.length} 条历史，可调用 /restore 恢复`
  });
}));

// v5.4.2: 恢复（restore）—— 从 undo_history 恢复
taskRouter.post('/:id/restore', asyncHandler((req, res) => {
  const historyIndex = req.body?.history_index !== undefined ? parseInt(String(req.body.history_index), 10) : undefined;
  const task = taskQueue.restoreTask(req.params.id, historyIndex);
  if (!task) {
    return res.status(400).json({ success: false, error: '任务不存在或没有可恢复的历史' });
  }
  res.json({ success: true, data: task, message: '任务已恢复' });
}));

// v5.4.3: 补充对话（followup）—— 基于已完成任务创建新任务，附带 parent 上下文
// 典型用法：用户对概览的结论想继续追问，提交一段补充说明 → 派生出新任务
taskRouter.post('/:id/followup', asyncHandler((req, res) => {
  const { content, type, priority } = req.body || {};
  if (!content || typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ success: false, error: '缺少 content 或内容为空' });
  }
  const result = taskQueue.createFollowupTask({
    parent_task_id: req.params.id,
    content,
    type: type as TaskType | undefined,
    priority: priority as TaskPriority | undefined
  });
  if (!result) {
    return res.status(404).json({ success: false, error: '父任务不存在' });
  }
  sessionManager.touchSession(result.task.session_id || 'sess-default');
  res.json({
    success: true,
    data: result.task,
    parent_id: result.parent.id,
    message: `已创建补充任务: ${result.task.id}（父: ${result.parent.id}）`
  });
}));

// evidence（独立端点，便于按需加载）
taskRouter.get('/:id/evidence', asyncHandler((req, res) => {
  const task = taskQueue.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  res.json({
    success: true,
    data: {
      task_id: task.id,
      evidence: task.result?.evidence || null
    }
  });
}));

// ======== /api/task/* (Trae Agent 专用) ========
// 注意：静态路径（/poll /stats /complete）必须在 /:id 之前注册，否则会被 :id 吞掉

// 提交结果（含 evidence）
taskRouter.post('/complete', asyncHandler((req, res) => {
  const { task_id, status, result, evidence, context_summary } = req.body || {};
  if (!task_id || !status || !result) {
    return res.status(400).json({
      success: false,
      error: '缺少必要字段: task_id, status, result'
    });
  }

  const taskResult: TaskResult = {
    task_id,
    status,
    result,
    evidence,
    context_summary: context_summary || {
      session_id: 'default',
      active_conversations: [],
      global_state: { current_focus: '', scheduled_tasks: [], alerts: [] }
    },
    completed_at: Date.now()
  };

  taskQueue.submitResult(taskResult);

  if (context_summary) {
    taskQueue.saveContext(context_summary.session_id || 'default', context_summary);
  }

  res.json({ success: true, message: '结果已接收' });
}));

// 任务状态（合并 status + result + evidence）
taskRouter.get('/:id/status', asyncHandler((req, res) => {
  const task = taskQueue.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  res.json({
    success: true,
    data: { task, result: task.result || null }
  });
}));

// 任务结果（含 evidence + completed 标志）
taskRouter.get('/:id/result', asyncHandler((req, res) => {
  const task = taskQueue.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  res.json({
    success: true,
    data: {
      task_id: task.id,
      status: task.status,
      result: task.result || null,
      evidence: task.result?.evidence || null,
      completed: task.status === 'completed' || task.status === 'failed'
    }
  });
}));

// ======== /api/context ========

contextRouter.get('/:sessionId', asyncHandler((req, res) => {
  res.json({ success: true, data: taskQueue.getContext(req.params.sessionId) || null });
}));

contextRouter.get('/', asyncHandler((_req, res) => {
  res.json({ success: true, data: taskQueue.getContext('default') || null });
}));

// ======== /api/logs ========

logRouter.get('/', asyncHandler((req, res) => {
  const level = req.query.level as LogLevel | undefined;
  const source = req.query.source as LogSource | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

  const logs = taskQueue.getLogs({ level, source, limit });
  res.json({ success: true, data: logs, meta: { total: logs.length } });
}));
