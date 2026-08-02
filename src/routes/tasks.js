import express from 'express';

/**
 * tasks.js —— 任务领取/汇报 + 任务管理（SPEC §4）
 * 挂载于 /api。
 * 另导出 pickPendingTask / claimTask / completeTask / createTask 供 mcp.js 复用。
 */

const TASK_TYPES = ['chat', 'reply_message', 'query_info', 'analyze_data', 'generate_content', 'execute_command', 'multi_step'];
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 按 SPEC §4 优先级选一个 pending 任务：
 * 1. target_agent===agent.id
 * 2. 无 target_agent 且 required_capability ∈ agent.capabilities
 * 3. 无 target_agent 且无 required_capability
 * 同优先级取 created_at 最小者。agent 为 null 时走兼容模式：任意 pending 先到先得。
 */
export function pickPendingTask(tasksColl, agent) {
  const pendings = tasksColl
    .filter((t) => t.status === 'pending')
    .sort((a, b) => a.created_at - b.created_at);
  if (!agent) return pendings[0] || null;
  const caps = agent.capabilities || [];
  const buckets = [[], [], []];
  for (const t of pendings) {
    if (t.target_agent) {
      if (t.target_agent === agent.id) buckets[0].push(t);
      continue; // 指定了其他 agent 的任务不可领
    }
    if (t.required_capability) {
      if (caps.includes(t.required_capability)) buckets[1].push(t);
      continue;
    }
    buckets[2].push(t);
  }
  for (const b of buckets) if (b.length) return b[0];
  return null;
}

/** 选中任务：置 processing / assigned_to / started_at 并发射事件 */
export function claimTask(ctx, task, agent) {
  const patch = { status: 'processing', started_at: ctx.util.now() };
  if (agent) patch.assigned_to = agent.id;
  const updated = ctx.store.coll('tasks').update(task.id, patch);
  ctx.events.emit('task:changed', updated);
  return updated;
}

/** 汇报完成/失败：更新任务 + agent.stats 并发射事件 */
export function completeTask(ctx, task, agent, status, result) {
  const coll = ctx.store.coll('tasks');
  const updated = coll.update(task.id, {
    status,
    completed_at: ctx.util.now(),
    result: result || null,
  });
  // stats 累计：优先凭证 agent，否则按 assigned_to 找
  const agents = ctx.store.coll('agents');
  const who = agent || (task.assigned_to ? agents.get(task.assigned_to) : null);
  if (who) {
    const stats = who.stats || { total: 0, success: 0 };
    agents.update(who.id, {
      stats: { total: stats.total + 1, success: stats.success + (status === 'completed' ? 1 : 0) },
    });
  }
  ctx.events.emit('task:changed', updated);
  return updated;
}

/** 建任务（REST 与 MCP 共用） */
export function createTask(ctx, { type, priority, source, data, target_agent, required_capability, parent_task_id, session_id }) {
  const task = {
    id: ctx.util.uid('task'),
    type: TASK_TYPES.includes(type) ? type : 'execute_command',
    priority: PRIORITIES.includes(priority) ? priority : 'normal',
    source,
    data: data || {},
    status: 'pending',
    created_at: ctx.util.now(),
  };
  if (target_agent) task.target_agent = target_agent;
  if (required_capability) task.required_capability = required_capability;
  if (parent_task_id) task.parent_task_id = parent_task_id;
  if (session_id) task.session_id = session_id;
  ctx.store.coll('tasks').insert(task);
  ctx.events.emit('task:changed', task);
  return task;
}

/** agent 凭证尝试中间件工厂：凭证有效则 req.agent 并放行；否则回退到 requireUser */
function agentOrUser(ctx) {
  return (req, res, next) => {
    const agent_id = req.body?.agent_id || req.query.agent_id;
    const token = req.body?.token || req.query.token;
    if (agent_id || token) {
      const agent = ctx.store.coll('agents').get(agent_id);
      if (agent && token && ctx.auth.verifySecret(token, agent.token_hash)) {
        if (agent.review_status !== 'active') {
          return res.status(403).json({ error: agent.review_status });
        }
        req.agent = agent;
        return next();
      }
      // 凭证无效则按用户通道处理（requireUser 会兜底 401）
    }
    return ctx.auth.requireUser(req, res, next);
  };
}

export default function (ctx) {
  const { store, events, auth, util } = ctx;
  const router = express.Router();
  const tasks = () => store.coll('tasks');

  // ---- GET /api/task/poll（带凭证 requireAgent；无 agent_id 兼容模式）----
  router.get(
    '/task/poll',
    (req, res, next) => {
      if (req.query.agent_id !== undefined || req.query.token !== undefined) {
        return auth.requireAgent()(req, res, next);
      }
      next();
    },
    async (req, res) => {
      const timeout = Math.min(Math.max(Number(req.query.timeout) || 30, 0), 30);
      const deadline = Date.now() + timeout * 1000;
      let task = null;
      for (;;) {
        task = pickPendingTask(tasks(), req.agent || null);
        if (task || Date.now() >= deadline) break;
        await sleep(500);
      }
      if (!task) return res.json({ task: null });
      const updated = claimTask(ctx, task, req.agent || null);
      res.json({ task: updated });
    }
  );

  // ---- POST /api/task/progress（agent 上报中间进展）----
  router.post(
    '/task/progress',
    (req, res, next) => {
      if (req.body?.agent_id !== undefined || req.body?.token !== undefined) {
        return auth.requireAgent()(req, res, next);
      }
      next();
    },
    (req, res) => {
      const { task_id, progress } = req.body || {};
      if (!task_id || typeof progress !== 'string' || !progress.trim()) {
        return res.status(400).json({ error: 'task_id and progress(text) required' });
      }
      const task = tasks().get(task_id);
      if (!task) return res.status(404).json({ error: 'task not found' });
      if (req.agent && task.assigned_to !== req.agent.id) {
        return res.status(403).json({ error: 'task not assigned to this agent' });
      }
      const updates = {
        progress: progress.trim(),
        progress_at: util.now(),
      };
      if (task.status !== 'processing') updates.status = 'processing';
      const updated = tasks().update(task.id, updates);
      ctx.events.emit('task:changed', updated);
      store.log('info', 'tasks', `任务 ${task.id} 进展：${updates.progress}`);
      res.json({ ok: true, task: updated });
    }
  );

  // ---- POST /api/task/complete ----
  router.post(
    '/task/complete',
    (req, res, next) => {
      if (req.body?.agent_id !== undefined || req.body?.token !== undefined) {
        return auth.requireAgent()(req, res, next);
      }
      next();
    },
    (req, res) => {
      const { task_id, status, result } = req.body || {};
      if (!task_id || !['completed', 'failed'].includes(status)) {
        return res.status(400).json({ error: 'task_id and status(completed|failed) required' });
      }
      const task = tasks().get(task_id);
      if (!task) return res.status(404).json({ error: 'task not found' });
      if (req.agent && task.assigned_to !== req.agent.id) {
        return res.status(403).json({ error: 'task not assigned to this agent' });
      }
      const updated = completeTask(ctx, task, req.agent || null, status, result);
      res.json({ ok: true, task: updated });
    }
  );

  // ---- GET /api/tasks/stats（须在 /tasks/:id 之前注册）----
  router.get('/tasks/stats', auth.requireUser, (req, res) => {
    const all = tasks().all();
    const stats = { pending: 0, processing: 0, completed: 0, failed: 0, total: all.length };
    for (const t of all) {
      if (t.status === 'pending') stats.pending += 1;
      else if (t.status === 'processing' || t.status === 'assigned') stats.processing += 1;
      else if (t.status === 'completed') stats.completed += 1;
      else if (t.status === 'failed') stats.failed += 1;
    }
    res.json(stats);
  });

  // ---- GET /api/tasks（过滤：status/source/agent/since/limit/q）----
  router.get('/tasks', auth.requireUser, (req, res) => {
    const { status, source, agent, since, q } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
    let list = tasks().all();
    if (status) list = list.filter((t) => t.status === status);
    if (source) list = list.filter((t) => t.source === source);
    if (agent) list = list.filter((t) => t.assigned_to === agent || t.target_agent === agent);
    if (since) {
      const s = Number(since);
      if (!Number.isNaN(s)) list = list.filter((t) => t.created_at >= s);
    }
    if (q) {
      const needle = String(q).toLowerCase();
      list = list.filter((t) => String(t.data?.content || '').toLowerCase().includes(needle));
    }
    list.sort((a, b) => b.created_at - a.created_at);
    res.json(list.slice(0, limit));
  });

  // ---- GET /api/tasks/:id（含 children）----
  router.get('/tasks/:id', auth.requireUser, (req, res) => {
    const task = tasks().get(req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const children = tasks()
      .filter((t) => t.parent_task_id === task.id)
      .sort((a, b) => a.created_at - b.created_at);
    res.json({ ...task, children });
  });

  // ---- POST /api/tasks（requireUser 或 requireAgent——agent 创建即委派）----
  router.post('/tasks', agentOrUser(ctx), (req, res) => {
    const { type, priority, data, target_agent, required_capability, parent_task_id, session_id } = req.body || {};
    if (!data || typeof data.content !== 'string' || !data.content.trim()) {
      return res.status(400).json({ error: 'data.content required' });
    }
    if (target_agent && !store.coll('agents').get(target_agent)) {
      return res.status(404).json({ error: 'target_agent not found' });
    }
    if (parent_task_id && !tasks().get(parent_task_id)) {
      return res.status(404).json({ error: 'parent_task_id not found' });
    }
    // source：agent 调用强制 delegation；带 parent_task_id 也是委派；否则 manual
    const source = req.agent || parent_task_id ? 'delegation' : 'manual';
    const task = createTask(ctx, {
      type, priority, source, data, target_agent, required_capability, parent_task_id, session_id,
    });
    store.log('info', 'tasks', `任务创建 ${task.id}（source=${source}）：${String(data.content).slice(0, 50)}`);
    res.status(201).json(task);
  });

  // ---- POST /api/tasks/:id/retry ----
  router.post('/tasks/:id/retry', auth.requireUser, (req, res) => {
    const task = tasks().get(req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    const updated = tasks().update(task.id, {
      status: 'pending',
      assigned_to: null,
      started_at: null,
      completed_at: null,
      result: null,
    });
    events.emit('task:changed', updated);
    res.json(updated);
  });

  // ---- POST /api/tasks/:id/reassign {target_agent}（仅 pending/failed，可清空为自动）----
  router.post('/tasks/:id/reassign', auth.requireUser, (req, res) => {
    const task = tasks().get(req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    if (!['pending', 'failed'].includes(task.status)) {
      return res.status(409).json({ error: `cannot reassign task in status ${task.status}` });
    }
    const { target_agent } = req.body || {};
    if (target_agent && !store.coll('agents').get(target_agent)) {
      return res.status(404).json({ error: 'target_agent not found' });
    }
    const updated = tasks().update(task.id, {
      target_agent: target_agent || null,
      status: 'pending',
      assigned_to: null,
      started_at: null,
      completed_at: null,
      result: null,
    });
    events.emit('task:changed', updated);
    res.json(updated);
  });

  // ---- DELETE /api/tasks/:id ----
  router.delete('/tasks/:id', auth.requireUser, (req, res) => {
    const task = tasks().get(req.params.id);
    if (!task) return res.status(404).json({ error: 'task not found' });
    tasks().remove(task.id);
    events.emit('task:changed', { ...task, deleted: true });
    res.json({ ok: true });
  });

  return router;
}
