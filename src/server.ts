import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { taskQueue } from './task-queue.js';
import { storage } from './storage.js';
import { sessionManager } from './session.js';
import { TaskResult, TaskType, TaskPriority, TaskSource, HeartbeatResponse, LogLevel, LogSource, SessionStatus } from './types.js';
import { clawManager } from './claw/index.js';
import { clawConfig } from './claw/config.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set<WebSocket>();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  // 调试：捕获所有 404 资源请求，方便排查前端加载问题
  res.on('finish', () => {
    if (res.statusCode === 404 && req.method === 'GET' && !req.path.startsWith('/api/')) {
      console.warn(`[404] ${req.method} ${req.path}`);
    }
  });
  next();
});
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

// 兜底：favicon.ico 用 1x1 透明 PNG 响应（避免浏览器 404 噪声）
app.get('/favicon.ico', (_req, res) => {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  // 1x1 透明 PNG (base64 decoded)
  res.send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=', 'base64'));
});

// ======== WebSocket ========

wss.on('connection', (ws) => {
  clients.add(ws);
  taskQueue.addLog('info', 'server', `WS 客户端连接，当前 ${clients.size}`);

  ws.send(JSON.stringify({ type: 'status', data: taskQueue.getStats() }));

  ws.on('close', () => {
    clients.delete(ws);
    taskQueue.addLog('info', 'server', `WS 客户端断开，当前 ${clients.size}`);
  });

  ws.on('error', (err) => {
    taskQueue.addLog('error', 'server', `WS 错误: ${err.message}`);
  });
});

function broadcast(type: string, data: any) {
  const msg = JSON.stringify({ type, data });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

taskQueue.on('task_added', (task) => broadcast('task_added', task));
taskQueue.on('task_completed', (result) => broadcast('task_completed', result));
taskQueue.on('log_added', (entry) => broadcast('log_added', entry));
taskQueue.on('task_deleted', (task) => broadcast('task_deleted', { id: task.id }));

// ======== Claw WebSocket Events ========
//
// 当 adapter 状态变化或收到新消息时，推送给所有 WS 客户端。
// 监听器由 startServer() 中根据 adapter 实例挂载（避免模块加载时 adapter 还未就绪）。

export function attachClawListeners(adapter: any) {
  adapter.on('status', (status: any) => broadcast('claw_status', status));
  adapter.on('qrcode', (data: any) => broadcast('claw_qrcode', data));
  adapter.on('message', (msg: any) => broadcast('wechat_message', msg));
  adapter.on('error', (err: Error) => broadcast('claw_error', { message: err.message }));
}

// ======== Health & Heartbeat ========

app.get('/health', (req, res) => {
  res.json({
    success: true,
    data: {
      bridge: 'running',
      version: '5.0.0',
      websocket_clients: clients.size,
      storage: storage.getStorageStats(),
      timestamp: Date.now()
    }
  });
});

// ======== Storage API (v3.0.0) ========

// Storage 统计
app.get('/api/storage/stats', (req, res) => {
  res.json({ success: true, data: storage.getStorageStats() });
});

// 导出所有数据（备份）
app.get('/api/storage/export', async (req, res) => {
  try {
    const data = await storage.exportAll();
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 导入数据（恢复）
app.post('/api/storage/import', async (req, res) => {
  try {
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ success: false, error: '缺少 data 字段' });
    }
    const result = await storage.importData(data);
    res.json({ success: true, data: result, message: '导入完成' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 清空所有数据（危险）
app.post('/api/storage/wipe', async (req, res) => {
  try {
    await storage.wipeAll();
    taskQueue.addLog('warn', 'bridge', '所有数据已清空');
    res.json({ success: true, message: '已清空' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/heartbeat', (req, res) => {
  const stats = taskQueue.getStats();
  const urgentTasks = taskQueue.getPendingTasks().filter(t => t.priority === 'urgent');
  const sessions = sessionManager.listSessions({ status: 'active' }).map(s => ({
    id: s.id,
    name: s.name,
    task_count: s.task_count
  }));

  const response: HeartbeatResponse = {
    server_time: Date.now(),
    agent_online: true,
    has_urgent_task: urgentTasks.length > 0,
    queue_stats: stats,
    pending_count: stats.pending,
    processing_count: stats.processing
  };

  (response as any).sessions = sessions;
  (response as any).default_session_id = sessionManager.getDefaultSessionId();
  (response as any).kb_stats = (() => {
    const kb = kbStore.list();
    return { categories: kb.categories.length, items: kb.items.length, total: kb.total };
  })();
  (response as any).wf_stats = (() => {
    const wfs = workflowStore.list();
    return { workflows: wfs.length, total_steps: wfs.reduce((s, w) => s + w.steps.length, 0) };
  })();

  res.json({ success: true, data: response });
});

// ======== Stats ========

app.get('/api/stats', (req, res) => {
  res.json({ success: true, data: taskQueue.getStats() });
});

// ======== Session API (v3.0.0) ========

// 列出会话（支持 status 过滤 + q 搜索）
app.get('/api/sessions', (req, res) => {
  const status = req.query.status as SessionStatus | undefined;
  const q = req.query.q as string | undefined;
  const sessions = sessionManager.listSessions({ status, q });
  res.json({
    success: true,
    data: sessions,
    meta: { total: sessions.length, default_session_id: sessionManager.getDefaultSessionId() }
  });
});

// 创建会话
app.post('/api/sessions', (req, res) => {
  try {
    const { name, description, meta } = req.body;
    const session = sessionManager.createSession({ name, description, meta });
    taskQueue.addLog('info', 'task', `会话创建: ${session.id} (${session.name})`, { session_id: session.id });
    res.json({ success: true, data: session });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 会话详情
app.get('/api/sessions/:id', (req, res) => {
  const session = sessionManager.getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ success: false, error: '会话不存在' });
  }
  res.json({ success: true, data: session });
});

// 更新会话
app.patch('/api/sessions/:id', (req, res) => {
  try {
    const updated = sessionManager.updateSession(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ success: false, error: '会话不存在' });
    }
    taskQueue.addLog('info', 'task', `会话更新: ${updated.id} (${updated.name})`, { session_id: updated.id });
    res.json({ success: true, data: updated });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 删除会话（任务重新归属默认会话）
app.delete('/api/sessions/:id', (req, res) => {
  try {
    const result = sessionManager.deleteSession(req.params.id);
    if (!result.ok) {
      return res.status(404).json({ success: false, error: '会话不存在' });
    }
    taskQueue.addLog('warn', 'task', `会话删除: ${req.params.id}，${result.reassigned_tasks} 个任务已重新归属默认会话`, { session_id: req.params.id });
    res.json({ success: true, message: '已删除', data: result });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 会话内任务列表
app.get('/api/sessions/:id/tasks', (req, res) => {
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
});

// ======== Knowledge Base API ========
// 知识库：分类（category） + 条目（item）
// 全部事件以 JSONL append-only 写入 data/kb.jsonl

import { kbStore } from './kb-store.js';
import { kbLinkStore } from './kb-link-store.js';

// 列表（categories + items + links）
app.get('/api/kb', (_req, res) => {
  const data = kbStore.list();
  const links = kbLinkStore.list();
  res.json({ success: true, data: { ...data, links: links.links } });
});

// 追加演示数据（分类 + 条目；按 name/title 查重）
app.post('/api/kb/seed-demo', (req, res) => {
  try {
    const result = kbStore.seedDemo();
    // 同时为新条目尝试创建演示关联
    const all = kbStore.list();
    const linksResult = kbLinkStore.seedDemo(all.items);
    taskQueue.addLog('info', 'kb', `KB 演示追加: ${result.categories_added} 分类 / ${result.items_added} 条目 / ${linksResult.links_added} 关联`);
    res.json({
      success: true,
      data: {
        categories_added: result.categories_added,
        items_added: result.items_added,
        links_added: linksResult.links_added,
        links_skipped: linksResult.links_skipped
      },
      message: `新增 ${result.categories_added} 分类 / ${result.items_added} 条目 / ${linksResult.links_added} 关联`
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 创建分类
app.post('/api/kb/categories', (req, res) => {
  try {
    const { name, icon } = req.body || {};
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'name 必填且非空' });
    }
    const cat = kbStore.createCategory(name, icon);
    taskQueue.addLog('info', 'kb', `KB 分类创建: ${cat.id} (${cat.name})`, { kb_id: cat.id });
    res.json({ success: true, data: cat });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 更新分类
app.patch('/api/kb/categories/:id', (req, res) => {
  const updated = kbStore.updateCategory(req.params.id, req.body || {});
  if (!updated) {
    return res.status(404).json({ success: false, error: '分类不存在' });
  }
  res.json({ success: true, data: updated });
});

// 删除分类（其下 item 归档为 __orphan__）
app.delete('/api/kb/categories/:id', (req, res) => {
  const ok = kbStore.deleteCategory(req.params.id);
  if (!ok) {
    return res.status(404).json({ success: false, error: '分类不存在' });
  }
  taskQueue.addLog('warn', 'kb', `KB 分类删除: ${req.params.id}`, { kb_id: req.params.id });
  res.json({ success: true, data: { id: req.params.id } });
});

// 创建条目
app.post('/api/kb/items', (req, res) => {
  try {
    const { category_id, title, body, tags } = req.body || {};
    if (!title || typeof title !== 'string' || !body || typeof body !== 'string') {
      return res.status(400).json({ success: false, error: 'title / body 必填且非空' });
    }
    const item = kbStore.createItem(category_id || '__orphan__', title, body, tags);
    if (!item) {
      return res.status(400).json({ success: false, error: 'category_id 不存在' });
    }
    taskQueue.addLog('info', 'kb', `KB 条目创建: ${item.id} (${item.title})`, { kb_id: item.id });
    res.json({ success: true, data: item });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 更新条目
app.patch('/api/kb/items/:id', (req, res) => {
  const updated = kbStore.updateItem(req.params.id, req.body || {});
  if (!updated) {
    return res.status(404).json({ success: false, error: '条目不存在' });
  }
  res.json({ success: true, data: updated });
});

// 删除条目（级联删除关联）
app.delete('/api/kb/items/:id', (req, res) => {
  const id = req.params.id;
  const ok = kbStore.deleteItem(id);
  if (!ok) {
    return res.status(404).json({ success: false, error: '条目不存在' });
  }
  const cascaded = kbLinkStore.cascadeDeleteForItem(id);
  taskQueue.addLog('warn', 'kb', `KB 条目删除: ${id}`, { kb_id: id, cascaded_links: cascaded });
  res.json({ success: true, data: { id, cascaded_links: cascaded } });
});

// ======== KB 关联（知识图谱） ========
// 列表
app.get('/api/kb/links', (req, res) => {
  const itemId = req.query.item_id as string | undefined;
  const data = itemId ? { links: kbLinkStore.getForItem(itemId) } : kbLinkStore.list();
  res.json({ success: true, data: { ...data, total: data.links.length } });
});

// 追加演示关联（按 title 查重，已存在则跳过）
app.post('/api/kb/links/seed-demo', (req, res) => {
  try {
    const all = kbStore.list();
    const result = kbLinkStore.seedDemo(all.items);
    taskQueue.addLog('info', 'kb', `KB 关联演示: 新增 ${result.links_added} 条，跳过 ${result.links_skipped} 条`);
    res.json({ success: true, data: result, message: `新增 ${result.links_added} 条关联` });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 创建关联
app.post('/api/kb/links', (req, res) => {
  try {
    const { source_id, target_id, type, label } = req.body || {};
    if (!source_id || !target_id) {
      return res.status(400).json({ success: false, error: 'source_id 和 target_id 必填' });
    }
    // 校验条目存在
    if (!kbStore.getItem(source_id)) {
      return res.status(400).json({ success: false, error: `源条目不存在: ${source_id}` });
    }
    if (!kbStore.getItem(target_id)) {
      return res.status(400).json({ success: false, error: `目标条目不存在: ${target_id}` });
    }
    const result = kbLinkStore.create(source_id, target_id, type || 'related', label);
    if ('error' in result) {
      return res.status(400).json({ success: false, error: result.error });
    }
    taskQueue.addLog('info', 'kb', `KB 关联创建: ${result.source_id} → ${result.target_id} (${result.type})`, { link_id: result.id });
    res.json({ success: true, data: result });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 删除关联
app.delete('/api/kb/links/:id', (req, res) => {
  const ok = kbLinkStore.delete(req.params.id);
  if (!ok) {
    return res.status(404).json({ success: false, error: '关联不存在' });
  }
  taskQueue.addLog('warn', 'kb', `KB 关联删除: ${req.params.id}`);
  res.json({ success: true, data: { id: req.params.id } });
});

// ======== Workflow API ========
// 多步任务模板：CRUD + 一键执行（批量创建 task）

import { workflowStore } from './workflow-store.js';
import { WorkflowExecution, WFExecuteResp } from './workflow-types.js';

// 列表
app.get('/api/wf', (_req, res) => {
  res.json({ success: true, data: workflowStore.list() });
});

// 追加演示工作流（按 name 查重）
app.post('/api/wf/seed-demo', (req, res) => {
  try {
    const result = workflowStore.seedDemo();
    taskQueue.addLog('info', 'system', `工作流演示追加: ${result.added} 个`);
    res.json({ success: true, data: result, message: `新增 ${result.added} 个工作流` });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 详情
app.get('/api/wf/:id', (req, res) => {
  const wf = workflowStore.get(req.params.id);
  if (!wf) {
    return res.status(404).json({ success: false, error: '工作流不存在' });
  }
  res.json({ success: true, data: wf });
});

// 创建
app.post('/api/wf', (req, res) => {
  try {
    const { name, icon, description, steps } = req.body || {};
    if (!name || typeof name !== 'string' || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ success: false, error: 'name 必填，steps 至少 1 步' });
    }
    const wf = workflowStore.create(name, icon, description, steps);
    taskQueue.addLog('info', 'system', `工作流创建: ${wf.id} (${wf.name}, ${wf.steps.length} 步)`, { wf_id: wf.id });
    res.json({ success: true, data: wf });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 更新
app.patch('/api/wf/:id', (req, res) => {
  const updated = workflowStore.update(req.params.id, req.body || {});
  if (!updated) {
    return res.status(404).json({ success: false, error: '工作流不存在' });
  }
  res.json({ success: true, data: updated });
});

// 删除
app.delete('/api/wf/:id', (req, res) => {
  const ok = workflowStore.delete(req.params.id);
  if (!ok) {
    return res.status(404).json({ success: false, error: '工作流不存在' });
  }
  taskQueue.addLog('warn', 'system', `工作流删除: ${req.params.id}`, { wf_id: req.params.id });
  res.json({ success: true, data: { id: req.params.id } });
});

// 执行（核心）：按 steps 顺序创建 task，返回 execution_id + task_ids
app.post('/api/wf/:id/execute', (req, res) => {
  const wf = workflowStore.get(req.params.id);
  if (!wf) {
    return res.status(404).json({ success: false, error: '工作流不存在' });
  }
  const sessionId: string = (req.body && req.body.session_id) || 'sess-default';

  const execution_id = `wfexec-${Date.now()}`;
  const task_ids: string[] = [];
  // 用 Map<stepId, taskId> 在依赖步骤和 task id 之间建立映射
  const stepIdToTaskId = new Map<string, string>();

  for (const step of wf.steps) {
    const task = taskQueue.createManualTask(
      step.content,
      (step.task_type as any) || 'query_info',
      (step.priority as any) || 'normal'
    );
    // 关联 workflow 元数据
    storage.updateTask(task.id, {
      session_id: sessionId,
      source: 'workflow',
      data: {
        ...task.data,
        wf_id: wf.id,
        wf_name: wf.name,
        wf_execution_id: execution_id,
        wf_step_id: step.id,
        wf_step_name: step.name,
        wf_step_depends_on: step.depends_on || []
      }
    } as any);
    task_ids.push(task.id);
    stepIdToTaskId.set(step.id, task.id);
  }

  const exec: WorkflowExecution = {
    workflow_id: wf.id,
    execution_id,
    started_at: Date.now(),
    task_ids
  };
  workflowStore.recordExecution(exec);

  taskQueue.addLog('success', 'system', `工作流执行: ${wf.name} (${task_ids.length} 任务)`, {
    wf_id: wf.id,
    execution_id,
    task_count: task_ids.length
  });

  const resp: WFExecuteResp = { execution_id, task_ids };
  res.json({ success: true, data: resp });
});

// ======== Tasks API ========
app.get('/api/tasks', (req, res) => {
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
});

// 单个任务详情（含 evidence）
app.get('/api/tasks/:id', (req, res) => {
  const task = taskQueue.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  res.json({ success: true, data: task });
});

// 创建任务（聊天即任务，type=chat 默认为对话）
app.post('/api/tasks', (req, res) => {
  try {
    const {
      content,
      type = 'chat',
      priority = 'normal',
      source = 'manual',
      from_user,
      session_id
    } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({ success: false, error: '缺少 content 或类型错误' });
    }

    // 解析 session_id：缺省/不存在则走默认会话
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

    // 刷新会话 updated_at
    sessionManager.touchSession(targetSession.id);

    res.json({ success: true, data: { ...task, session_id: targetSession.id } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 删除任务
app.delete('/api/tasks/:id', (req, res) => {
  const ok = taskQueue.deleteTask(req.params.id);
  if (!ok) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  res.json({ success: true, message: '已删除' });
});

// 重试任务
app.post('/api/tasks/:id/retry', (req, res) => {
  const task = taskQueue.retryTask(req.params.id);
  if (!task) {
    return res.status(400).json({ success: false, error: '任务不存在或状态不允许重试' });
  }
  res.json({ success: true, data: task, message: '任务已重新入队' });
});

// 获取任务 evidence（独立端点，便于按需加载）
app.get('/api/tasks/:id/evidence', (req, res) => {
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
});

// ======== Trae Agent API ========

// 长轮询
app.get('/api/task/poll', async (req, res) => {
  const timeout = Math.min(parseInt(req.query.timeout as string) || 30000, 60000);

  try {
    const task = await taskQueue.pollTask(timeout);
    if (task) {
      res.json({ success: true, has_task: true, task });
    } else {
      res.json({ success: true, has_task: false });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 提交结果（含 evidence）
app.post('/api/task/complete', (req, res) => {
  try {
    const { task_id, status, result, evidence, context_summary } = req.body;

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
      taskQueue.saveContext(
        context_summary.session_id || 'default',
        context_summary
      );
    }

    res.json({ success: true, message: '结果已接收' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 任务状态（合并 status + result + evidence）
app.get('/api/task/:id/status', (req, res) => {
  const task = taskQueue.getTask(req.params.id);
  if (!task) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  res.json({
    success: true,
    data: {
      task,
      result: task.result || null
    }
  });
});

app.get('/api/task/:id/result', (req, res) => {
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
});

app.get('/api/task/stats', (req, res) => {
  res.json({ success: true, data: taskQueue.getStats() });
});

// ======== Context API ========

app.get('/api/context/:sessionId', (req, res) => {
  res.json({ success: true, data: taskQueue.getContext(req.params.sessionId) || null });
});

app.get('/api/context', (req, res) => {
  res.json({ success: true, data: taskQueue.getContext('default') || null });
});

// ======== System Log API ========

app.get('/api/logs', (req, res) => {
  const level = req.query.level as LogLevel | undefined;
  const source = req.query.source as LogSource | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

  const logs = taskQueue.getLogs({ level, source, limit });
  res.json({ success: true, data: logs, meta: { total: logs.length } });
});

// ======== Legacy Chat API (兼容旧前端调用，内部等价于 POST /api/tasks { type: 'chat' }) ========

app.post('/api/chat', (req, res) => {
  try {
    const { message, session_id = 'chat-session' } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ success: false, error: '缺少 message' });
    }
    const task = taskQueue.createChatTask(message);

    const context = taskQueue.getContext(session_id) || {
      session_id,
      active_conversations: [] as any[],
      global_state: { current_focus: '', scheduled_tasks: [], alerts: [] }
    };
    const existingConv = context.active_conversations.find(c => c.user_id === 'chat-user');
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
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/chat/history', (req, res) => {
  // 兼容旧接口：从 type=chat 的任务中拼出历史
  const session_id = (req.query.session_id as string) || 'chat-session';
  const chatTasks = taskQueue.getRecentTasks(50, { type: 'chat' });
  const history = chatTasks.flatMap(t => {
    const msgs: any[] = [{ role: 'user', content: t.data.content, timestamp: t.created_at, task_id: t.id }];
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
});

// ======== Claw API (v4.0.0) ========

// 推送 claw 状态给所有 WS 客户端
function broadcastClawStatus(status: any) {
  broadcast('claw_status', status);
}

// 当前状态
app.get('/api/claw/status', (req, res) => {
  res.json({ success: true, data: clawManager.getStatus() });
});

// 触发登录（生成新二维码或重新连接）
app.post('/api/claw/login/start', async (req, res) => {
  try {
    const adapter = clawManager.getAdapter();
    if (adapter) {
      // 已启动 adapter，触发重新登录（清凭证 → 重新扫码）
      await adapter.logout();
    }
    // 重启 adapter 让它走 start() 的扫码流程
    await clawManager.startIlink();
    taskQueue.addLog('info', 'bridge', '[claw] 触发登录 (ilink)');
    res.json({ success: true, data: clawManager.getStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 退出登录
app.post('/api/claw/logout', async (req, res) => {
  try {
    const adapter = clawManager.getAdapter();
    if (adapter) await adapter.logout();
    res.json({ success: true, message: '已退出' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 重启 adapter
app.post('/api/claw/restart', async (req, res) => {
  try {
    await clawManager.restart();
    res.json({ success: true, data: clawManager.getStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 联系人列表
app.get('/api/claw/contacts', async (req, res) => {
  try {
    const adapter = clawManager.getAdapter();
    if (!adapter) return res.json({ success: true, data: [], message: '微信未连接' });
    const list = await adapter.listContacts();
    res.json({ success: true, data: list });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 群聊列表
app.get('/api/claw/rooms', async (req, res) => {
  try {
    const adapter = clawManager.getAdapter();
    if (!adapter) return res.json({ success: true, data: [], message: '微信未连接' });
    const list = await adapter.listRooms();
    res.json({ success: true, data: list });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 二维码 PNG（用 qrcode 库把 iLink 深链渲染为图片）
app.get('/api/claw/qrcode.png', async (req, res) => {
  try {
    const adapter = clawManager.getAdapter() as any;
    if (!adapter || typeof adapter.getCurrentQrcode !== 'function') {
      return res.status(404).type('text/plain').send('QR not available: adapter not initialized');
    }
    const cur = adapter.getCurrentQrcode();
    if (!cur) {
      return res.status(404).type('text/plain').send('QR not available: not in qrcode state');
    }
    if (cur.expiresAt < Date.now()) {
      return res.status(410).type('text/plain').send('QR expired');
    }
    const QRCode = (await import('qrcode')).default;
    const png = await QRCode.toBuffer(cur.url, {
      type: 'png',
      errorCorrectionLevel: 'M',
      width: 280,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-QR-Expires-At', String(cur.expiresAt));
    res.send(png);
  } catch (err: any) {
    res.status(500).type('text/plain').send(`QR render failed: ${err.message}`);
  }
});

// 主动发送文本
app.post('/api/claw/send', async (req, res) => {
  try {
    const { wxid, content } = req.body;
    if (!wxid || !content) {
      return res.status(400).json({ success: false, error: '缺少 wxid 或 content' });
    }
    const adapter = clawManager.getAdapter();
    if (!adapter) return res.status(503).json({ success: false, error: '微信未连接' });
    const msgId = await adapter.sendText(wxid, content);
    taskQueue.addLog('info', 'task', `主动发送: → ${wxid} (msgId=${msgId})`, { wxid, msg_id: msgId });
    res.json({ success: true, data: { msg_id: msgId } });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 获取/更新配置
app.get('/api/claw/config', (req, res) => {
  res.json({ success: true, data: clawConfig.get() });
});

app.patch('/api/claw/config', (req, res) => {
  try {
    const updated = clawConfig.update(req.body || {});
    res.json({ success: true, data: updated });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ======== iLink 状态查询 ========

import * as secretsFs from 'fs';
import * as secretsOs from 'os';
import * as secretsPath from 'path';

const SECRETS_FILE = secretsPath.join(secretsOs.homedir(), '.config', 'agent-canvas', 'secrets.env');

app.get('/api/claw/ilink/credentials', (req, res) => {
  try {
    if (!secretsFs.existsSync(SECRETS_FILE)) {
      return res.json({ success: true, data: { configured: false } });
    }
    const content = secretsFs.readFileSync(SECRETS_FILE, 'utf-8');
    const out: Record<string, string> = { configured: 'partial' };
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      if (k.startsWith('ILINK_')) {
        const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
        if (k === 'ILINK_BOT_TOKEN' || k === 'ILINK_GET_UPDATES_BUF') {
          out[k] = v ? `${v.slice(0, 6)}…(len=${v.length})` : '';
        } else {
          out[k] = v;
        }
      }
    }
    out['configured'] = !!(out['ILINK_BOT_TOKEN'] && out['ILINK_BOT_ID'] && out['ILINK_USER_ID'])
      ? 'true'
      : 'partial';
    res.json({ success: true, data: out });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ======== Legacy Weixin API (保留兼容，前端不再使用) ========

app.get('/api/messages', (req, res) => {
  res.json({ success: true, data: [], message: '微信守护进程未连接' });
});
app.get('/api/contacts', (req, res) => {
  res.json({ success: true, data: [], message: '微信守护进程未连接' });
});
app.post('/api/send', (req, res) => {
  res.status(503).json({ success: false, error: '微信守护进程未连接' });
});
app.post('/api/reply', (req, res) => {
  res.status(503).json({ success: false, error: '微信守护进程未连接' });
});
app.post('/api/mark-read', (req, res) => {
  res.json({ success: true, message: '微信守护进程未连接' });
});

// ======== Home ========

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ======== Start ========

export function startServer(port: number = 4567) {
  // 启动时从磁盘恢复数据
  const loadResult = storage.loadAll();
  // loadAll 之后激活 TaskQueue 的 ID 计数器（基于现有最大 ID 续编）
  taskQueue.initCounters();
  // loadAll 之后确保默认会话存在
  sessionManager.ensureDefaultSession();
  // 加载知识库（如无 kb.jsonl 则写入示例数据）
  const kbLoad = kbStore.loadAll();
  // 加载知识库关联（首次启动 seed 示例关联）
  const kbLinksLoad = kbLinkStore.loadAll();
  seedKBLinksIfEmpty();
  // 加载工作流（如无 wf.jsonl 则写入示例数据）
  const wfLoad = workflowStore.loadAll();

  taskQueue.addLog(
    'success',
    'bridge',
    `数据恢复完成: 任务 ${loadResult.tasks}, 日志 ${loadResult.logs}, 会话 ${loadResult.sessions}, 损坏行 ${loadResult.corrupted}`,
    loadResult as any
  );
  taskQueue.addLog(
    kbLoad.seeded ? 'success' : 'info',
    'kb',
    `知识库${kbLoad.seeded ? '已初始化（首次启动写入示例）' : '已加载'}: 分类 ${kbLoad.categories}, 条目 ${kbLoad.items}`,
    kbLoad as any
  );
  taskQueue.addLog(
    wfLoad.seeded ? 'success' : 'info',
    'system',
    `工作流${wfLoad.seeded ? '已初始化（首次启动写入示例）' : '已加载'}: ${wfLoad.workflows} 个`,
    wfLoad as any
  );

  // 启动微信 Claw（v4.0.0）
  clawManager.start().then(() => {
    const adapter = clawManager.getAdapter();
    if (adapter) {
      attachClawListeners(adapter);
    }
  });

  server.listen(port, () => {
    taskQueue.addLog('success', 'bridge', `服务启动，端口 ${port}`);
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║   AI 智能体桥接器 v5.0.0 已启动          ║');
    console.log('║   通用 Claw 适配层已挂载                 ║');
    console.log('║   持久化：JSONL (data/*.jsonl)           ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  Web面板:   http://localhost:${port}      ║`);
    console.log(`║  HTTP API:  http://localhost:${port}/api ║`);
    console.log(`║  WebSocket: ws://localhost:${port}/ws    ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log('数据恢复:');
    console.log(`  任务: ${loadResult.tasks} | 日志: ${loadResult.logs} | 会话: ${loadResult.sessions}`);
    if (loadResult.corrupted > 0) {
      console.log(`  ⚠️  发现 ${loadResult.corrupted} 行损坏数据，已移至 data/.corrupted/`);
    }
    console.log('');
    console.log('Claw (v4.1.0 iLink):');
    const cfg = clawConfig.get();
    console.log(`  状态: ${cfg.enabled ? '✅ 启用' : '❌ 禁用'}`);
    console.log(`  adapter: iLink Bot API (官方 SDK vendor)`);
    console.log(`  凭证位置: ~/.config/agent-canvas/secrets.env (chmod 600)`);
    console.log(`  auto_reply: ${cfg.auto_reply}`);
    console.log('');
    console.log('核心端点:');
    console.log('  GET  /api/heartbeat         心跳保活');
    console.log('  GET  /api/task/poll         长轮询 (Trae)');
    console.log('  POST /api/task/complete     提交结果 (含 evidence)');
    console.log('  POST /api/tasks             创建任务/聊天');
    console.log('  GET  /api/tasks             任务列表');
    console.log('  GET  /api/tasks/:id         任务详情');
    console.log('  GET  /api/tasks/:id/evidence 执行依据');
    console.log('  POST /api/tasks/:id/retry   重试');
    console.log('  DELETE /api/tasks/:id       删除');
    console.log('  GET  /api/logs              系统日志');
    console.log('  GET  /api/storage/stats     存储统计');
    console.log('  GET  /api/storage/export    导出备份');
    console.log('  GET  /api/sessions          列出/搜索会话');
    console.log('  POST /api/sessions          创建会话');
    console.log('  GET  /api/sessions/:id      会话详情');
    console.log('  PATCH /api/sessions/:id     更新会话');
    console.log('  DELETE /api/sessions/:id    删除会话');
    console.log('  GET  /api/sessions/:id/tasks 会话任务');
    console.log('  GET  /api/claw/status       微信连接状态');
    console.log('  POST /api/claw/login/start  触发扫码登录');
    console.log('  POST /api/claw/logout       退出登录');
    console.log('  GET  /api/claw/ilink/credentials 查看 iLink 凭证');
    console.log('');
  });
}

// ======== KB 关联示例数据 ========
/**
 * 首次启动且无关联时，根据已有条目创建示例关联
 * 仅在 kb_links.jsonl 不存在时触发（loadAll 会创建空文件）
 */
function seedKBLinksIfEmpty(): void {
  if (kbLinkStore.list().total > 0) return;
  const { items } = kbStore.list();
  if (items.length < 2) return;

  // 按 title 找示例条目
  const find = (kw: string) => items.find(i => i.title.includes(kw));
  const maotai = find('茅台');
  const price = find('查茅台价格');
  const weather = find('查北京天气');
  const report = find('销售月报');
  const storage = find('数据存储');
  const jsonl = find('JSONL 事件流');
  const startKb = find('ai-bridge 如何启动');
  const bridge = find('iLink 微信');

  const tryLink = (s: any, t: any, type: any, label?: string) => {
    if (!s || !t) return;
    const r = kbLinkStore.create(s.id, t.id, type, label);
    if ('error' in r) console.warn('[seedKB] link skipped:', r.error);
  };

  // 业务知识 ↔ Prompt 模板：references
  tryLink(maotai, price, 'references', '用于查询价格');
  tryLink(report, storage, 'references', '依赖数据存储');
  tryLink(bridge, startKb, 'related', '相关概念');
  tryLink(storage, jsonl, 'related', '格式定义');
}

