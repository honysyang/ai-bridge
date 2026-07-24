import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { taskQueue } from './task-queue.js';
import { storage } from './storage.js';
import { sessionManager } from './session.js';
import { clawManager } from './claw/index.js';
import { clawConfig } from './claw/config.js';
import { kbStore } from './kb-store.js';
import { kbLinkStore } from './kb-link-store.js';
import { workflowStore } from './workflow-store.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { healthRouter, storageRouter } from './routes/health.js';
import { sessionRouter } from './routes/sessions.js';
import { taskRouter, contextRouter, logRouter } from './routes/tasks.js';
import { kbRouter } from './routes/kb.js';
import { workflowRouter } from './routes/workflows.js';
import { chatRouter } from './routes/chat.js';
import { clawRouter, legacyWeixinRouter } from './routes/claw.js';
import { heartbeatRouter } from './routes/heartbeat.js';
import { overviewRouter } from './routes/overview.js';
import { modelRouter } from './routes/models.js';
import { systemRouter } from './routes/system.js';
import { errorHandler } from './middleware/error.js';
import { notFoundHandler } from './middleware/notFound.js';
import { childLogger, logRequest } from './lib/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const log = childLogger({ module: 'server' });

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const clients = new Set<WebSocket>();
app.set('wsClients', clients); // 暴露给 router 用（/health 读 WS 客户端数）

// ======== 基础中间件 ========

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 调试：捕获所有 404 资源请求，方便排查前端加载问题
app.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode === 404 && req.method === 'GET' && !req.path.startsWith('/api/')) {
      log.warn(`静态资源 404: ${req.method} ${req.path}`);
    }
  });
  next();
});

// HTTP 访问日志（v5.2.0：接入 winston 诊断通道）
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    // 跳过心跳/健康检查的高频噪音
    if (req.path === '/api/heartbeat' || req.path === '/api/task/poll' || req.path === '/health') return;
    logRequest(req.method, req.path, res.statusCode, Date.now() - start);
  });
  next();
});

// ======== CORS（白名单，从环境变量读，缺省允许同源 + localhost）========

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4567',
  'http://127.0.0.1:4567',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin as string | undefined;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    // 同源请求（无 Origin header）放行
    res.header('Access-Control-Allow-Origin', '*');
  }
  // 显式禁止的跨域 origin 不设置 ACAO header，由浏览器拦截
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ======== 静态资源 ========

app.use(express.static(path.join(__dirname, '../public')));

// 兜底：favicon.ico 用 1x1 透明 PNG 响应（避免浏览器 404 噪声）
app.get('/favicon.ico', (_req, res) => {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=', 'base64'));
});

// ======== WebSocket ========

wss.on('connection', (ws) => {
  clients.add(ws);
  log.debug(`WS 客户端连接，当前 ${clients.size}`);

  ws.send(JSON.stringify({ type: 'status', data: taskQueue.getStats() }));

  ws.on('close', () => {
    clients.delete(ws);
    log.debug(`WS 客户端断开，当前 ${clients.size}`);
  });

  ws.on('error', (err) => {
    log.error(`WS 错误: ${err.message}`);
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

// ======== 路由挂载（拆分子模块，详见 src/routes/*）========

// 健康 + 存储
app.use('/health', healthRouter);
app.use('/api/storage', storageRouter);

// 心跳（合并 health + 业务状态）
app.use('/api/heartbeat', heartbeatRouter);

// 业务模块
app.use('/api/sessions', sessionRouter);
app.use('/api/tasks', taskRouter);
// /api/task/* (Trae Agent 长轮询、提交结果) 复用 taskRouter
app.use('/api/task', taskRouter);
app.use('/api/context', contextRouter);
app.use('/api/logs', logRouter);
app.use('/api/kb', kbRouter);
app.use('/api/wf', workflowRouter);
app.use('/api/chat', chatRouter);
app.use('/api/claw', clawRouter);
app.use('/api/overview', overviewRouter);
app.use('/api/models', modelRouter);
app.use('/api/system', systemRouter);
// 旧 weixin 路径兼容（前端不再使用）
app.use('/api', legacyWeixinRouter);

// 全局 stats（保留兼容老前端）
app.get('/api/stats', (_req, res) => {
  res.json({ success: true, data: taskQueue.getStats() });
});

// ======== Home ========

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ======== 404 兜底 + 错误处理（必须放最后）========

app.use(notFoundHandler);
app.use(errorHandler);

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
    const cfg = clawConfig.get();
    log.info('═══════════════════════════════════════════');
    log.info('  AI 智能体桥接器 v5.2.0 已启动（winston 日志已接入）');
    log.info('═══════════════════════════════════════════');
    log.info('  Web面板:   http://localhost:' + port);
    log.info('  HTTP API:  http://localhost:' + port + '/api');
    log.info('  WebSocket: ws://localhost:' + port + '/ws');
    log.info('  日志目录:  logs/ai-bridge-YYYY-MM-DD.log');
    log.info('  级别:      ' + (process.env.LOG_LEVEL || 'info') + ' (LOG_LEVEL 环境变量可调)');
    log.info('═══════════════════════════════════════════');
    log.info(`数据恢复: 任务 ${loadResult.tasks} | 日志 ${loadResult.logs} | 会话 ${loadResult.sessions}` +
      (loadResult.corrupted > 0 ? ` | ⚠️ 损坏 ${loadResult.corrupted}` : ''));
    log.info(`Claw: ${cfg.enabled ? '✅ 启用' : '❌ 禁用'} | auto_reply=${cfg.auto_reply}`);
    log.info(`CORS 白名单: ${ALLOWED_ORIGINS.join(', ')}`);
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
