import { Router } from 'express';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { taskQueue } from '../task-queue.js';
import { clawManager } from '../claw/index.js';
import { clawConfig } from '../claw/config.js';
import { asyncHandler } from '../middleware/error.js';

/**
 * Claw (微信/iLink) 管理路由
 * - GET    /api/claw/status
 * - POST   /api/claw/login/start
 * - POST   /api/claw/logout
 * - POST   /api/claw/restart
 * - GET    /api/claw/contacts
 * - GET    /api/claw/rooms
 * - GET    /api/claw/qrcode.png
 * - POST   /api/claw/send
 * - GET    /api/claw/config
 * - PATCH  /api/claw/config
 * - GET    /api/claw/ilink/credentials
 */
export const clawRouter = Router();

// 当前状态
clawRouter.get('/status', asyncHandler((_req, res) => {
  res.json({ success: true, data: clawManager.getStatus() });
}));

// 消息桥接队列状态（请求-回答 1:1 对应状态）
clawRouter.get('/queue', asyncHandler((_req, res) => {
  // 动态访问 messageBridge（避免循环依赖）
  const bridge = (clawManager as any).bridge;
  const queue = bridge && typeof bridge.getQueueStatus === 'function'
    ? bridge.getQueueStatus()
    : [];
  res.json({ success: true, data: { queues: queue, total_wxids: queue.length } });
}));

// 总结状态（v4.3）
clawRouter.get('/summary', asyncHandler((_req, res) => {
  const bridge = (clawManager as any).bridge;
  const status = bridge && typeof bridge.getSummaryStatus === 'function'
    ? bridge.getSummaryStatus()
    : [];
  res.json({ success: true, data: { trackers: status, total_wxids: status.length } });
}));

// 手动触发总结
clawRouter.post('/summary', asyncHandler(async (req, res) => {
  const wxid = (req.body && req.body.wxid) as string | undefined;
  if (!wxid) {
    return res.status(400).json({ success: false, error: '缺少 wxid' });
  }
  const bridge = (clawManager as any).bridge;
  if (!bridge || typeof bridge.triggerSummaryNow !== 'function') {
    return res.status(503).json({ success: false, error: 'message-bridge 未就绪' });
  }
  const result = await bridge.triggerSummaryNow(wxid);
  res.json({ success: true, data: result });
}));

// 触发登录（生成新二维码或重新连接）
clawRouter.post('/login/start', asyncHandler(async (req, res) => {
  const adapter = clawManager.getAdapter();
  if (adapter) {
    await adapter.logout();
  }
  await clawManager.startIlink();
  taskQueue.addLog('info', 'bridge', '[claw] 触发登录 (ilink)');
  res.json({ success: true, data: clawManager.getStatus() });
}));

// 退出登录
clawRouter.post('/logout', asyncHandler(async (_req, res) => {
  const adapter = clawManager.getAdapter();
  if (adapter) await adapter.logout();
  res.json({ success: true, message: '已退出' });
}));

// 重启 adapter
clawRouter.post('/restart', asyncHandler(async (_req, res) => {
  await clawManager.restart();
  res.json({ success: true, data: clawManager.getStatus() });
}));

// 联系人列表
clawRouter.get('/contacts', asyncHandler(async (_req, res) => {
  const adapter = clawManager.getAdapter();
  if (!adapter) return res.json({ success: true, data: [], message: '微信未连接' });
  const list = await adapter.listContacts();
  res.json({ success: true, data: list });
}));

// 群聊列表
clawRouter.get('/rooms', asyncHandler(async (_req, res) => {
  const adapter = clawManager.getAdapter();
  if (!adapter) return res.json({ success: true, data: [], message: '微信未连接' });
  const list = await adapter.listRooms();
  res.json({ success: true, data: list });
}));

// 二维码 PNG
clawRouter.get('/qrcode.png', asyncHandler(async (_req, res) => {
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
    color: { dark: '#000000', light: '#ffffff' }
  });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-QR-Expires-At', String(cur.expiresAt));
  res.send(png);
}));

// 主动发送文本
clawRouter.post('/send', asyncHandler(async (req, res) => {
  const { wxid, content } = req.body || {};
  if (!wxid || !content) {
    return res.status(400).json({ success: false, error: '缺少 wxid 或 content' });
  }
  const adapter = clawManager.getAdapter();
  if (!adapter) return res.status(503).json({ success: false, error: '微信未连接' });
  const msgId = await adapter.sendText(wxid, content);
  taskQueue.addLog('info', 'task', `主动发送: → ${wxid} (msgId=${msgId})`, { wxid, msg_id: msgId });
  res.json({ success: true, data: { msg_id: msgId } });
}));

// 配置 GET
clawRouter.get('/config', asyncHandler((_req, res) => {
  res.json({ success: true, data: clawConfig.get() });
}));

// 配置 PATCH
clawRouter.patch('/config', asyncHandler((req, res) => {
  const updated = clawConfig.update(req.body || {});
  res.json({ success: true, data: updated });
}));

// ======== v5.5.0: 空闲提醒（Idle Notifier）=======

// 状态查询
clawRouter.get('/idle/status', asyncHandler((_req, res) => {
  const notifier = clawManager.getIdleNotifier();
  if (!notifier) {
    return res.json({
      success: true,
      data: {
        enabled: false,
        initialized: false,
        message: 'idle notifier 未初始化（微信未启动？）'
      }
    });
  }
  res.json({ success: true, data: { initialized: true, ...notifier.getStatus() } });
}));

// 手动触发一次 tick（用于测试）
clawRouter.post('/idle/tick', asyncHandler(async (_req, res) => {
  const notifier = clawManager.getIdleNotifier();
  if (!notifier) {
    return res.status(503).json({ success: false, error: 'idle notifier 未初始化' });
  }
  try {
    const result = await notifier.tickNow();
    res.json({ success: true, data: result });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
}));

// 预览消息（不发，用于前端 dry-run 调试）
clawRouter.post('/idle/preview', asyncHandler(async (req, res) => {
  const notifier = clawManager.getIdleNotifier();
  if (!notifier) {
    return res.status(503).json({ success: false, error: 'idle notifier 未初始化' });
  }
  const wxid = (req.body && req.body.wxid) as string | undefined;
  // 复用 notifier 的 composeDailySummary / composeTaskSummary
  // 这里通过 getStatus 拿到 types，然后逐个组合
  const status = notifier.getStatus();
  // 简化：返回当前会发的内容（dry-run 模拟）
  res.json({
    success: true,
    data: {
      ...status,
      preview_note: '这是模拟预览（不真发）。完整预览逻辑见 idle-notifier.composeIdleText'
    }
  });
  if (wxid) { /* 保持参数兼容 */ }
}));

// ======== iLink 凭证状态（只读）=======
const SECRETS_FILE = path.join(os.homedir(), '.config', 'agent-canvas', 'secrets.env');

clawRouter.get('/ilink/credentials', asyncHandler((_req, res) => {
  if (!fs.existsSync(SECRETS_FILE)) {
    return res.json({ success: true, data: { configured: false } });
  }
  const content = fs.readFileSync(SECRETS_FILE, 'utf-8');
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
}));

// ======== 兼容旧 Weixin API（保留路径，前端不再使用）=======
export const legacyWeixinRouter = Router();

legacyWeixinRouter.get('/messages', (_req, res) => {
  res.json({ success: true, data: [], message: '微信守护进程未连接' });
});
legacyWeixinRouter.get('/contacts', (_req, res) => {
  res.json({ success: true, data: [], message: '微信守护进程未连接' });
});
legacyWeixinRouter.post('/send', (_req, res) => {
  res.status(503).json({ success: false, error: '微信守护进程未连接' });
});
legacyWeixinRouter.post('/reply', (_req, res) => {
  res.status(503).json({ success: false, error: '微信守护进程未连接' });
});
legacyWeixinRouter.post('/mark-read', (_req, res) => {
  res.json({ success: true, message: '微信守护进程未连接' });
});
