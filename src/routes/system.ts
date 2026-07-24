// ======== 系统设置路由（v5.3.0 新增）========
//
// GET   /api/system/settings     读取设置
// PATCH /api/system/settings     局部更新
// POST  /api/system/settings/reset 恢复默认
// GET   /api/system/info         服务端运行时信息（版本、Node、内存、启动时间、commit）
// POST  /api/system/cleanup      清理过期日志/归档

import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { systemSettings, DEFAULT_SYSTEM_SETTINGS } from '../lib/settings.js';
import { taskQueue } from '../task-queue.js';
import { asyncHandler } from '../middleware/error.js';
import { sqliteStore } from '../lib/sqlite-store.js';

export const systemRouter = Router();

// 默认值（前端可读，知道有哪些字段）
systemRouter.get('/settings/defaults', asyncHandler((_req, res) => {
  res.json({ success: true, data: DEFAULT_SYSTEM_SETTINGS });
}));

// 读取
systemRouter.get('/settings', asyncHandler((_req, res) => {
  res.json({ success: true, data: systemSettings.get() });
}));

// 更新
systemRouter.patch('/settings', asyncHandler((req, res) => {
  const before = systemSettings.get();
  const updated = systemSettings.update(req.body || {});
  taskQueue.addLog('info', 'system', `[system] 设置已更新`);
  res.json({ success: true, data: updated, before });
}));

// 重置
systemRouter.post('/settings/reset', asyncHandler((_req, res) => {
  const fresh = systemSettings.reset();
  taskQueue.addLog('info', 'system', '[system] 设置已重置为默认');
  res.json({ success: true, data: fresh });
}));

// 运行时信息
systemRouter.get('/info', asyncHandler((_req, res) => {
  const dataDir = path.join(process.cwd(), 'data');
  let dataBytes = 0;
  let dataFiles = 0;
  try {
    if (fs.existsSync(dataDir)) {
      for (const f of fs.readdirSync(dataDir)) {
        if (f.startsWith('.')) continue;
        const fp = path.join(dataDir, f);
        const st = fs.statSync(fp);
        if (st.isFile()) {
          dataBytes += st.size;
          dataFiles += 1;
        }
      }
    }
  } catch {}

  const mem = process.memoryUsage();
  res.json({
    success: true,
    data: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptime_sec: Math.floor(process.uptime()),
      started_at: Date.now() - Math.floor(process.uptime() * 1000),
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024)
      },
      data_dir: dataDir,
      data_files: dataFiles,
      data_bytes: dataBytes,
      cwd: process.cwd(),
      env: {
        NODE_ENV: process.env.NODE_ENV || 'production',
        LOG_LEVEL: process.env.LOG_LEVEL || 'info',
        PORT: process.env.PORT || '4567'
      }
    }
  });
}));

// 清理：根据 retention_days 删除 logs/ 下的过期日志
systemRouter.post('/cleanup', asyncHandler((req, res) => {
  const retention = Math.max(0, parseInt((req.body && req.body.retention_days) ?? systemSettings.get().logs.retention_days, 10) || 0);
  const logsDir = path.join(process.cwd(), 'logs');
  let removed = 0;
  let kept = 0;
  const errors: string[] = [];
  if (fs.existsSync(logsDir)) {
    const cutoff = Date.now() - retention * 86400 * 1000;
    for (const f of fs.readdirSync(logsDir)) {
      if (!f.endsWith('.log')) continue;
      const fp = path.join(logsDir, f);
      try {
        const st = fs.statSync(fp);
        if (retention > 0 && st.mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          removed += 1;
        } else {
          kept += 1;
        }
      } catch (e: any) {
        errors.push(`${f}: ${e.message}`);
      }
    }
  }
  taskQueue.addLog('success', 'system', `[cleanup] 删除 ${removed} 个日志文件，保留 ${kept} 个（retention=${retention}d）`);
  res.json({ success: true, data: { removed, kept, retention_days: retention, errors } });
}));

// v5.4.2: SQLite 状态（表行数 + 文件大小 + 写错误数 + 迁移版本）
systemRouter.get('/sqlite/status', asyncHandler((_req, res) => {
  const counts = sqliteStore.getTableCounts();
  const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
  res.json({
    success: true,
    data: {
      healthy: sqliteStore.isHealthy(),
      file_size: sqliteStore.getDbFileSize(),
      write_errors: sqliteStore.getWriteErrors(),
      tables: counts,
      total_rows: totalRows,
      schema_version: sqliteStore.getMeta('schema_version'),
      migrated_at: sqliteStore.getMeta('migrated_at'),
      sync_enabled: process.env.AIBRIDGE_SQLITE_SYNC !== '0'
    }
  });
}));
