import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { taskQueue } from './task-queue.js';
import { storage } from './storage.js';
import { sessionManager } from './session.js';
import { clawManager } from './claw/index.js';
import { clawConfig } from './claw/config.js';
import { kbStore } from './kb-store.js';
import { scenarioStore } from './scenario-store.js';
import { scenarioKBLinkStore } from './scenario-kb-link-store.js';
import { kbChunkStore } from './kb-chunk-store.js';
import { kbLinkStore } from './kb-link-store.js';
import { workflowStore } from './workflow-store.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAppVersion } from './lib/version.js';
import { SECRETS_FILE } from './lib/paths.js';

import { healthRouter, storageRouter } from './routes/health.js';
import { sessionRouter } from './routes/sessions.js';
import { fsRouter } from './routes/fs.js';
import { taskRouter, contextRouter, logRouter } from './routes/tasks.js';
import { kbRouter } from './routes/kb.js';
import { workflowRouter } from './routes/workflows.js';
import { chatRouter } from './routes/chat.js';
import { clawRouter, legacyWeixinRouter } from './routes/claw.js';
import { heartbeatRouter } from './routes/heartbeat.js';
import { overviewRouter } from './routes/overview.js';
import { modelRouter } from './routes/models.js';
import { systemRouter } from './routes/system.js';
import { authRouter } from './routes/auth.js';
import { errorHandler } from './middleware/error.js';
import { notFoundHandler } from './middleware/notFound.js';
import { requireAuth } from './middleware/auth.js';
import { childLogger, logRequest } from './lib/logger.js';
import { users } from './lib/users.js';
import { runMigration, shouldMigrate } from './lib/sqlite-migrate.js';
import { checkStartupConfig, logConfigCheck } from './lib/config-check.js';
import { systemSettings } from './lib/settings.js';
import { publicRateLimiter, authRateLimiter } from './lib/rate-limit-api.js';
import { metrics } from './lib/metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const log = childLogger({ module: 'server' });

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// v5.5.6: 仅信任配置的代理，避免 X-Forwarded-For 伪造绕过本地认证
// 默认值：loopback / linklocal / uniquelocal（即 127.0.0.1、169.254.x.x、10.x.x.x、172.16-31.x.x、192.168.x.x）
// 公网部署时请显式设置 AIBRIDGE_TRUSTED_PROXIES 为你的反向代理 IP
const TRUSTED_PROXIES = (process.env.AIBRIDGE_TRUSTED_PROXIES || 'loopback,linklocal,uniquelocal')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.set('trust proxy', TRUSTED_PROXIES);

const clients = new Set<WebSocket>();
app.set('wsClients', clients); // 暴露给 router 用（/health 读 WS 客户端数）

// ======== 基础中间件 ========

// 限制请求体大小，防止过大 JSON 导致 DoS / 内存耗尽
const BODY_LIMIT = process.env.AIBRIDGE_BODY_LIMIT || '10mb';
app.use(express.json({ limit: BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: BODY_LIMIT }));

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
    const duration = Date.now() - start;
    const route = req.route?.path || req.path;
    const status = res.statusCode;
    // Prometheus 指标
    metrics.inc('http_requests_total', { method: req.method, route, status: String(status) });
    metrics.observe('http_request_duration_seconds', { method: req.method, route }, duration / 1000);
    // 跳过心跳/健康检查的高频噪音
    if (req.path === '/api/heartbeat' || req.path === '/api/task/poll' || req.path === '/health') return;
    logRequest(req.method, req.path, status, duration);
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
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin as string | undefined;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    // 无 Origin 的请求通常是同源或非浏览器客户端，不设置 ACAO，由浏览器默认同源策略保护
    // 如果需要支持无 Origin 的 API 调用，请显式加入 ALLOWED_ORIGINS
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

// v5.5.1: HTML 模板占位符替换（{VERSION} → 实际版本号）
// 解决 v5.3.0 缓存破坏 query string 写死后无法自动更新的问题
// - 命中范围：仅 .html 文件
// - 处理方式：命中 .html 时 readFile + 替换 + 发送
// - 性能：首页 / login.html 1 次读取，替换是 O(n) 简单字符串操作，无感知
const PUBLIC_DIR = path.join(__dirname, '../public');
const DOCS_DIR = path.join(process.cwd(), 'docs');

app.get(['/', '/index.html', '/login.html'], (req: Request, res: Response, next: NextFunction) => {
  try {
    const requested = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
    const filePath = path.join(PUBLIC_DIR, requested);
    if (!fs.existsSync(filePath)) return next();
    let html = fs.readFileSync(filePath, 'utf-8');
    // 替换 {VERSION} 占位符为当前版本
    html = html.replace(/\{VERSION\}/g, getAppVersion());
    // 禁用 HTML 缓存（避免 304 Not Modified 命中旧的占位符）
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(html);
  } catch (e) {
    next(e);
  }
});

app.use(express.static(PUBLIC_DIR));
// v6.0.0: 暴露 docs/screenshots 给前端弹窗使用本地图片，避免 Gitee raw 403
app.use('/docs/screenshots', express.static(path.join(DOCS_DIR, 'screenshots')));

// 兜底：favicon.ico 用 1x1 透明 PNG 响应（避免浏览器 404 噪声）
app.get('/favicon.ico', (_req, res) => {
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
      'base64'
    )
  );
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
  clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

taskQueue.on('task_added', (task) => {
  broadcast('task_added', task);
  metrics.inc('task_queue_operations_total', { operation: 'added' });
});
taskQueue.on('task_completed', (result) => {
  broadcast('task_completed', result);
  metrics.inc('task_queue_operations_total', { operation: 'completed' });
});
taskQueue.on('task_failed', (result) => {
  metrics.inc('task_queue_operations_total', { operation: 'failed' });
});
taskQueue.on('log_added', (entry) => broadcast('log_added', entry));
taskQueue.on('task_deleted', (task) => {
  broadcast('task_deleted', { id: task.id });
  metrics.inc('task_queue_operations_total', { operation: 'deleted' });
});

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

// Prometheus 指标端点
app.get('/metrics', (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(metrics.render());
});

// ======== 路由挂载（拆分子模块，详见 src/routes/*）========

// v5.4.0: 业务 API 默认要求登录（本地访问 + 公开端点自动放行）
// 必须放在 /api 路由挂载之前，否则后续 router 会先响应
app.use('/api', publicRateLimiter.middleware.bind(publicRateLimiter), requireAuth);

// 健康 + 存储
app.use('/health', healthRouter);
app.use('/api/storage', storageRouter);

// 心跳（合并 health + 业务状态）
app.use('/api/heartbeat', heartbeatRouter);

// 业务模块
app.use('/api/sessions', sessionRouter);
app.use('/api/fs', fsRouter); // v5.4.5: 路径补全
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
// 认证路由（登录/登出/me 等）—— 内部部分端点（如 /api/auth/login）公开，其他要求登录
app.use('/api/auth', authRateLimiter.middleware.bind(authRateLimiter), authRouter);
// 旧 weixin 路径兼容（前端不再使用）
app.use('/api', legacyWeixinRouter);

// 全局 stats（保留兼容老前端）
app.get('/api/stats', (_req, res) => {
  res.json({ success: true, data: taskQueue.getStats() });
});

// v5.5.6: API 版本化 —— /api/v1/* 与 /api/* 共享同一套路由
// 未来破坏性变更可在 v1 路由内部做兼容，或新增 /api/v2/*
app.use('/api/v1', requireAuth);
app.use('/api/v1/storage', storageRouter);
app.use('/api/v1/heartbeat', heartbeatRouter);
app.use('/api/v1/sessions', sessionRouter);
app.use('/api/v1/fs', fsRouter);
app.use('/api/v1/tasks', taskRouter);
app.use('/api/v1/task', taskRouter);
app.use('/api/v1/context', contextRouter);
app.use('/api/v1/logs', logRouter);
app.use('/api/v1/kb', kbRouter);
app.use('/api/v1/wf', workflowRouter);
app.use('/api/v1/chat', chatRouter);
app.use('/api/v1/claw', clawRouter);
app.use('/api/v1/overview', overviewRouter);
app.use('/api/v1/models', modelRouter);
app.use('/api/v1/system', systemRouter);
app.use('/api/v1/auth', authRateLimiter.middleware.bind(authRateLimiter), authRouter);
app.use('/api/v1', legacyWeixinRouter);
app.get('/api/v1/stats', (_req, res) => {
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

export async function startServer(port: number = 4567) {
  // 启动前配置校验
  const checkResult = checkStartupConfig();
  logConfigCheck(checkResult);
  if (!checkResult.ok) {
    throw new Error('启动配置校验失败，请检查日志并修正环境变量');
  }

  // 启动时从磁盘恢复数据
  const loadResult = storage.loadAll();
  // loadAll 之后激活 TaskQueue 的 ID 计数器（基于现有最大 ID 续编）
  taskQueue.initCounters();
  // loadAll 之后确保默认会话存在
  await sessionManager.ensureDefaultSession();
  // 确保默认管理员存在（首次启动写入 secrets.env）
  const adminInit = users.ensureDefaultAdmin();
  if (adminInit.created) {
    log.warn(`═══════════════════════════════════════════`);
    log.warn(`  ⚠️  默认管理员已创建`);
    log.warn(`  username: ${adminInit.username}`);
    log.warn(`  password: <已写入 ${SECRETS_FILE}>`);
    log.warn(`  请登录后尽快修改默认密码`);
    log.warn(`═══════════════════════════════════════════`);
  }
  // 加载场景（知识库顶层组织维度）
  const scenarioLoad = scenarioStore.loadAll();
  // 加载知识库（如无 kb.jsonl 则写入示例数据）
  const kbLoad = kbStore.loadAll();
  // 加载知识库片段
  const kbChunksLoad = kbChunkStore.loadAll();
  // 加载场景-条目关联
  const scenarioKBLinksLoad = scenarioKBLinkStore.loadAll();
  // 加载知识库关联（首次启动 seed 示例关联）
  const kbLinksLoad = kbLinkStore.loadAll();
  seedKBLinksIfEmpty();
  // v5.6.0: 后台索引所有 pending 的知识库条目
  kbStore.schedulePendingReindex();
  // 加载工作流（如无 wf.jsonl 则写入示例数据）
  const wfLoad = workflowStore.loadAll();

  taskQueue.addLog(
    'success',
    'bridge',
    `数据恢复完成: 任务 ${loadResult.tasks}, 日志 ${loadResult.logs}, 会话 ${loadResult.sessions}, 损坏行 ${loadResult.corrupted}`,
    loadResult as any
  );
  taskQueue.addLog(
    scenarioLoad.seeded ? 'success' : 'info',
    'kb',
    `知识库场景${scenarioLoad.seeded ? '已初始化（首次启动写入内置）' : '已加载'}: ${scenarioLoad.scenarios} 个`,
    scenarioLoad as any
  );
  taskQueue.addLog('info', 'kb', `知识库场景关联已加载: ${scenarioKBLinksLoad.links} 条`, scenarioKBLinksLoad as any);
  taskQueue.addLog(
    kbLoad.seeded ? 'success' : 'info',
    'kb',
    `知识库${kbLoad.seeded ? '已初始化（首次启动写入示例）' : '已加载'}: 分类 ${kbLoad.categories}, 条目 ${kbLoad.items}, chunks ${kbChunksLoad.chunks}`,
    { ...kbLoad, chunks: kbChunksLoad.chunks } as any
  );
  taskQueue.addLog(
    wfLoad.seeded ? 'success' : 'info',
    'system',
    `工作流${wfLoad.seeded ? '已初始化（首次启动写入示例）' : '已加载'}: ${wfLoad.workflows} 个`,
    wfLoad as any
  );

  // v5.4.2: SQLite 自动迁移（仅当 SQLite 为空且 JSONL 有数据时执行）
  if (shouldMigrate()) {
    log.info('检测到 SQLite 为空且 JSONL 有数据，开始自动迁移...');
    try {
      const migResult = runMigration();
      log.info(
        `SQLite 迁移完成: 任务 ${migResult.tasks}, 会话 ${migResult.sessions}, 日志 ${migResult.logs}, KB ${migResult.kb_items}, 工作流 ${migResult.workflows}, 用户 ${migResult.users} (${migResult.duration_ms}ms)`
      );
      if (migResult.errors.length > 0) {
        log.warn(`迁移部分失败: ${migResult.errors.join('; ')}`);
      }
    } catch (e: any) {
      log.error(`SQLite 迁移失败: ${e.message}`);
    }
  }

  // 启动微信 Claw（v4.0.0）
  clawManager.start().then(() => {
    const adapter = clawManager.getAdapter();
    if (adapter) {
      attachClawListeners(adapter);
    }
  });

  // v5.5.6: 定时数据维护（自动备份 + 归档）
  startMaintenanceScheduler();
  // v5.5.6: 定时刷新 Prometheus 指标
  setInterval(() => {
    const stats = taskQueue.getStats();
    metrics.set('task_queue_total', { status: 'pending' }, stats.pending);
    metrics.set('task_queue_total', { status: 'processing' }, stats.processing);
    metrics.set('task_queue_total', { status: 'completed' }, stats.completed);
    metrics.set('task_queue_total', { status: 'failed' }, stats.failed);
  }, 60 * 1000);

  server.listen(port, () => {
    taskQueue.addLog('success', 'bridge', `服务启动，端口 ${port}`);
    const cfg = clawConfig.get();
    log.info('═══════════════════════════════════════════');
    log.info(`  AI 智能体桥接器 v${getAppVersion()} 已启动（winston 日志已接入）`);
    log.info('═══════════════════════════════════════════');
    log.info('  Web面板:   http://localhost:' + port);
    log.info('  HTTP API:  http://localhost:' + port + '/api');
    log.info('  WebSocket: ws://localhost:' + port + '/ws');
    log.info('  日志目录:  logs/ai-bridge-YYYY-MM-DD.log');
    log.info('  级别:      ' + (process.env.LOG_LEVEL || 'info') + ' (LOG_LEVEL 环境变量可调)');
    log.info('═══════════════════════════════════════════');
    log.info(
      `数据恢复: 任务 ${loadResult.tasks} | 日志 ${loadResult.logs} | 会话 ${loadResult.sessions}` +
        (loadResult.corrupted > 0 ? ` | ⚠️ 损坏 ${loadResult.corrupted}` : '')
    );
    log.info(`Claw: ${cfg.enabled ? '✅ 启用' : '❌ 禁用'} | auto_reply=${cfg.auto_reply}`);
    log.info(`CORS 白名单: ${ALLOWED_ORIGINS.join(', ')}`);
  });
}

/**
 * 定时数据维护：
 *   - 每天 04:00 自动备份
 *   - 每天 04:30 自动归档已完成任务
 *   - 每周日 05:00 自动 compact
 */
function startMaintenanceScheduler(): void {
  const MS_PER_MIN = 60 * 1000;
  const now = new Date();
  const nextRun = (targetHour: number, targetMin: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetHour, targetMin, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime() - now.getTime();
  };

  setTimeout(
    () => {
      storage
        .backup()
        .then((r) => {
          storage.cleanupBackups(10);
          taskQueue.addLog('success', 'system', `[schedule] 自动备份完成: ${r.files.length} 个文件`);
        })
        .catch((e) => taskQueue.addLog('error', 'system', `[schedule] 自动备份失败: ${e.message}`));
      setInterval(
        () => {
          storage
            .backup()
            .then((r) => {
              storage.cleanupBackups(10);
              taskQueue.addLog('success', 'system', `[schedule] 自动备份完成: ${r.files.length} 个文件`);
            })
            .catch((e) => taskQueue.addLog('error', 'system', `[schedule] 自动备份失败: ${e.message}`));
        },
        24 * 60 * MS_PER_MIN
      );
    },
    nextRun(4, 0)
  );

  setTimeout(
    () => {
      const days = systemSettings.get().tasks.archive_after_days || 7;
      storage
        .archiveCompletedTasks(days)
        .then((r) => {
          if (r.archived > 0) taskQueue.addLog('success', 'system', `[schedule] 自动归档完成: ${r.archived} 个任务`);
        })
        .catch((e) => taskQueue.addLog('error', 'system', `[schedule] 自动归档失败: ${e.message}`));
      setInterval(
        () => {
          const d = systemSettings.get().tasks.archive_after_days || 7;
          storage
            .archiveCompletedTasks(d)
            .then((r) => {
              if (r.archived > 0)
                taskQueue.addLog('success', 'system', `[schedule] 自动归档完成: ${r.archived} 个任务`);
            })
            .catch((e) => taskQueue.addLog('error', 'system', `[schedule] 自动归档失败: ${e.message}`));
        },
        24 * 60 * MS_PER_MIN
      );
    },
    nextRun(4, 30)
  );

  setTimeout(
    () => {
      storage
        .compact()
        .then((r) => {
          taskQueue.addLog('success', 'system', `[schedule] 自动压缩完成: 任务 ${r.tasks}, 会话 ${r.sessions}`);
        })
        .catch((e) => taskQueue.addLog('error', 'system', `[schedule] 自动压缩失败: ${e.message}`));
      setInterval(
        () => {
          storage
            .compact()
            .then((r) => {
              taskQueue.addLog('success', 'system', `[schedule] 自动压缩完成: 任务 ${r.tasks}, 会话 ${r.sessions}`);
            })
            .catch((e) => taskQueue.addLog('error', 'system', `[schedule] 自动压缩失败: ${e.message}`));
        },
        7 * 24 * 60 * MS_PER_MIN
      );
    },
    nextRun(5, 0)
  );
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
  const find = (kw: string) => items.find((i) => i.title.includes(kw));
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
