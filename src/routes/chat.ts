import { Router } from 'express';
import { taskQueue } from '../task-queue.js';
import { asyncHandler } from '../middleware/error.js';

/**
 * 兼容旧前端的聊天 API（内部仍走 taskQueue）
 * - POST /api/chat          创建聊天任务
 * - GET  /api/chat/history  拉取历史（从 type=chat 的任务拼出）
 */
export const chatRouter = Router();

// 创建聊天任务
chatRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const { message, session_id = 'chat-session' } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: '缺少 message' });
    }
    const task = await taskQueue.createChatTask(message);

    const context = taskQueue.getContext(session_id) || {
      session_id,
      active_conversations: [] as any[],
      global_state: { current_focus: '', scheduled_tasks: [], alerts: [] }
    };
    const existingConv = context.active_conversations.find((c) => c.user_id === 'chat-user');
    if (existingConv) {
      existingConv.last_active = Date.now();
      existingConv.memory.push(message);
    } else {
      context.active_conversations.push({
        user_id: 'chat-user',
        last_active: Date.now(),
        topic: '聊天对话',
        pending_items: [],
        memory: [message]
      });
    }
    taskQueue.saveContext(session_id, context);

    res.json({
      success: true,
      data: { task_id: task.id, status: 'pending', message: '任务已创建' }
    });
  })
);

// 历史（type=chat 任务拼出）
chatRouter.get(
  '/history',
  asyncHandler((req, res) => {
    const session_id = (req.query.session_id as string) || 'chat-session';
    const chatTasks = taskQueue.getRecentTasks(50, { type: 'chat' });
    const history = chatTasks.flatMap((t) => {
      const msgs: any[] = [
        {
          role: 'user',
          content: t.data.content,
          timestamp: t.created_at,
          task_id: t.id
        }
      ];
      if (t.result) {
        msgs.push({
          role: 'assistant',
          content: t.result.result.summary,
          result: t.result.result.details,
          evidence: t.result.evidence,
          timestamp: t.completed_at,
          task_id: t.id
        });
      }
      return msgs;
    });
    res.json({
      success: true,
      data: { history, context: taskQueue.getContext(session_id) }
    });
  })
);

// 旧版无前缀端点兼容（部分老前端 /api/chat-history 之类）
chatRouter.get(
  '/-history-legacy',
  asyncHandler((req, res) => {
    res.redirect(301, '/api/chat/history?' + new URLSearchParams(req.query as any).toString());
  })
);
