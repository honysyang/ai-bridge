import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { storage } from '../storage.js';
import { taskQueue } from '../task-queue.js';
import { requireRole } from '../middleware/auth.js';
import { getAppVersion } from '../lib/version.js';
import { DATA_DIR } from '../lib/paths.js';
import { sqliteStore } from '../lib/sqlite-store.js';
import { writeAudit } from '../lib/audit.js';

/**
 * 健康检查 + 存储管理路由
 * - GET  /health              服务存活 + 存储快照
 * - GET  /api/storage/stats   各 jsonl 文件大小/行数
 * - GET  /api/storage/export  全量导出（备份）
 * - POST /api/storage/import  全量导入（恢复）
 * - POST /api/storage/wipe    清空（危险，仅 admin）
 */
export const healthRouter = Router();
export const storageRouter = Router();

// ======== /health ========
healthRouter.get('/', (req, res) => {
  // 深度健康检查
  const checks: Record<string, { healthy: boolean; detail?: string }> = {
    process: { healthy: true },
    sqlite: { healthy: sqliteStore.isHealthy() },
    disk: { healthy: true }
  };

  try {
    const stats = fs.statSync(DATA_DIR);
    // 粗略估算：数据目录所在分区剩余空间（Linux）
    // 不使用 node:fs 的 statfs（Node 20 可能不支持），用 df 命令
    let freeGb: number | undefined;
    try {
      const df = execSync(`df -BG "${DATA_DIR}" | tail -1`, { encoding: 'utf-8' }).trim();
      const parts = df.split(/\s+/);
      const avail = parts[parts.length - 3];
      if (avail) freeGb = parseInt(avail, 10);
    } catch {
      // ignore
    }
    checks.disk.detail = freeGb !== undefined ? `${freeGb} GB free` : 'unknown';
    if (freeGb !== undefined && freeGb < 1) {
      checks.disk.healthy = false;
    }
  } catch (e: any) {
    checks.disk = { healthy: false, detail: e.message };
  }

  const allHealthy = Object.values(checks).every((c) => c.healthy);
  const statusCode = allHealthy ? 200 : 503;

  res.status(statusCode).json({
    success: allHealthy,
    data: {
      bridge: allHealthy ? 'running' : 'degraded',
      version: getAppVersion(),
      websocket_clients: (req.app.get('wsClients') as Set<unknown>)?.size ?? 0,
      storage: storage.getStorageStats(),
      checks,
      timestamp: Date.now()
    }
  });
});

// ======== /api/storage/* ========
storageRouter.get('/stats', (_req, res) => {
  res.json({ success: true, data: storage.getStorageStats() });
});

storageRouter.get('/export', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  try {
    const data = await storage.exportAll();
    writeAudit({
      action: 'storage:export',
      actor: req.user ? { id: req.user.id, username: req.user.username, role: req.user.role } : null,
      ip
    });
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

storageRouter.post('/import', async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  try {
    const { data } = req.body;
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ success: false, error: '缺少 data 字段' });
    }
    const result = await storage.importData(data);
    writeAudit({
      action: 'storage:import',
      actor: req.user ? { id: req.user.id, username: req.user.username, role: req.user.role } : null,
      ip,
      after: result
    });
    res.json({ success: true, data: result, message: '导入完成' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

storageRouter.post('/wipe', requireRole('admin'), async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  try {
    await storage.wipeAll();
    taskQueue.addLog('warn', 'bridge', '所有数据已清空');
    writeAudit({
      action: 'storage:wipe',
      actor: req.user ? { id: req.user.id, username: req.user.username, role: req.user.role } : null,
      ip
    });
    res.json({ success: true, message: '已清空' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
