import express from 'express';
import { buildChatContext, compressSession, routeTask } from '../ai-chat.js';

/**
 * 聊天即任务。挂载于 /api/chat。
 */
export default function (ctx) {
  const router = express.Router();
  const { store, events, util } = ctx;
  const ru = ctx.auth.requireUser;
  const tasks = () => store.coll('tasks');

  router.post('/', ru, async (req, res) => {
    const rawContent = String(req.body?.content || '').trim();
    if (!rawContent) return res.status(400).json({ error: 'content required' });
    const session_id = req.body?.session_id || 'session-default';
    let content = rawContent;
    let target_agent = req.body?.target_agent || undefined;
    let required_capability = req.body?.required_capability || undefined;

    // 解析 @agentName 指派
    if (!target_agent) {
      const mention = content.match(/^@(\S+)\s*/);
      if (mention) {
        const name = mention[1];
        const agent = store.coll('agents').all().find((a) => a.review_status === 'active' && (a.name === name || a.id === name));
        if (agent) {
          target_agent = agent.id;
          content = content.slice(mention[0].length).trim();
        }
      }
    }

    // 智能路由：未手动指定 target_agent 和 capability 时尝试 AI 路由
    let routeInfo = null;
    if (!target_agent && !required_capability) {
      routeInfo = await routeTask(ctx, content);
      if (routeInfo.target_agent) target_agent = routeInfo.target_agent;
      else if (routeInfo.required_capability) required_capability = routeInfo.required_capability;
    } else {
      routeInfo = { by: 'manual', reason: '用户手动指定' };
    }

    // 构建上下文（recent 最近 6 条 + 会话 summary）
    const context = buildChatContext(ctx, session_id, content);

    const task = tasks().insert({
      id: util.uid('task'),
      type: 'chat',
      priority: 'normal',
      source: 'chat',
      data: {
        content,
        from_user: req.user.username,
        extra: {
          context,
          context_note: 'extra.context 包含会话摘要（summary）和最近 6 轮对话（recent），按时间顺序排列。请结合上下文理解当前问题，严禁使用上下文外的信息。',
        },
      },
      status: 'pending',
      session_id,
      target_agent,
      required_capability,
      extra: { route: routeInfo },
      from_chat: true,
      created_at: util.now(),
    });

    // 每新增 6 条已完成任务，异步压缩历史上下文
    compressSession(ctx, session_id).catch(() => {});

    events.emit('task:changed', task);
    res.status(201).json({ task });
  });

  router.post('/:sessionId/messages', ru, (req, res) => {
    const sessionId = req.params.sessionId;
    const text = String(req.body?.content || '').trim();
    if (!text) return res.status(400).json({ error: 'content required' });
    const id = util.uid('task');
    const virtual = {
      id,
      type: 'system_note',
      priority: 'normal',
      source: req.body?.source || 'system',
      data: { content: text },
      status: 'completed',
      session_id: sessionId,
      result: { summary: text },
      created_at: util.now(),
      completed_at: util.now(),
    };
    tasks().insert(virtual);
    res.status(201).json(virtual);
  });

  router.post('/retry', ru, (req, res) => {
    const { task_id, session_id } = req.body || {};
    if (!task_id) return res.status(400).json({ error: 'task_id required' });
    const task = tasks().get(task_id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const content = String(task.data?.content || '').trim();
    if (!content) return res.status(400).json({ error: 'original task has no content' });
    const newTask = tasks().insert({
      id: util.uid('task'),
      type: task.type || 'chat',
      priority: task.priority || 'normal',
      source: task.source || 'chat',
      data: {
        content,
        extra: {
          ...(task.data?.extra || {}),
          retried_from: task.id,
        },
      },
      status: 'pending',
      session_id: session_id || task.session_id || 'session-default',
      target_agent: task.target_agent || undefined,
      required_capability: task.required_capability || undefined,
      extra: { route: { by: 'manual', reason: '用户点击重试' } },
      created_at: util.now(),
    });
    events.emit('task:changed', newTask);
    res.status(201).json({ task: newTask });
  });

  router.post('/reassign', ru, (req, res) => {
    const { task_id, new_agent_id, session_id } = req.body || {};
    if (!task_id) return res.status(400).json({ error: 'task_id required' });
    const task = tasks().get(task_id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (new_agent_id && !store.coll('agents').get(new_agent_id)) {
      return res.status(404).json({ error: 'new_agent_id not found' });
    }
    const updated = tasks().update(task.id, {
      status: 'pending',
      assigned_to: null,
      started_at: null,
      completed_at: null,
      result: null,
      target_agent: new_agent_id || undefined,
      session_id: session_id !== undefined ? session_id : task.session_id,
      extra: { ...(task.extra || {}), route: { by: 'manual', reason: '用户改派' } },
    });
    events.emit('task:changed', updated);
    res.json({ task: updated });
  });

  router.get('/:sessionId/messages', ru, (req, res) => {
    const list = tasks()
      .all()
      .filter((t) => t.session_id === req.params.sessionId)
      .sort((a, b) => a.created_at - b.created_at);
    res.json(list);
  });

  return router;
}
