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
import { DATA_DIR } from '../lib/paths.js';
import { storage } from '../storage.js';
import { taskQueue } from '../task-queue.js';
import { asyncHandler } from '../middleware/error.js';
import { requireRole } from '../middleware/auth.js';
import { sqliteStore } from '../lib/sqlite-store.js';
import { getAppVersion, getAppName, getAppDescription } from '../lib/version.js';
import { writeAudit, readAudit, getAuditStats } from '../lib/audit.js';
import { skillRouter } from './skill.js';

export const systemRouter = Router();

// 默认值（前端可读，知道有哪些字段）
systemRouter.get(
  '/settings/defaults',
  asyncHandler((_req, res) => {
    res.json({ success: true, data: DEFAULT_SYSTEM_SETTINGS });
  })
);

// 读取
systemRouter.get(
  '/settings',
  asyncHandler((_req, res) => {
    res.json({ success: true, data: systemSettings.get() });
  })
);

// 更新
systemRouter.patch(
  '/settings',
  asyncHandler((req, res) => {
    const before = systemSettings.get();
    const updated = systemSettings.update(req.body || {});
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    taskQueue.addLog('info', 'system', `[system] 设置已更新`);
    writeAudit({
      action: 'system:settings:update',
      actor: req.user ? { id: req.user.id, username: req.user.username, role: req.user.role } : null,
      ip,
      before,
      after: updated
    });
    res.json({ success: true, data: updated, before });
  })
);

// 重置
systemRouter.post(
  '/settings/reset',
  asyncHandler((req, res) => {
    const fresh = systemSettings.reset();
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    taskQueue.addLog('info', 'system', '[system] 设置已重置为默认');
    writeAudit({
      action: 'system:settings:reset',
      actor: req.user ? { id: req.user.id, username: req.user.username, role: req.user.role } : null,
      ip
    });
    res.json({ success: true, data: fresh });
  })
);

// 运行时信息
systemRouter.get(
  '/info',
  asyncHandler((_req, res) => {
    const dataDir = DATA_DIR;
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
    } catch {
      /* ignore */
    }

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
  })
);

// 清理：根据 retention_days 删除 logs/ 下的过期日志（仅 admin）
systemRouter.post(
  '/cleanup',
  requireRole('admin'),
  asyncHandler((req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const retention = Math.max(
      0,
      parseInt((req.body && req.body.retention_days) ?? systemSettings.get().logs.retention_days, 10) || 0
    );
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
    taskQueue.addLog(
      'success',
      'system',
      `[cleanup] 删除 ${removed} 个日志文件，保留 ${kept} 个（retention=${retention}d）`
    );
    writeAudit({
      action: 'system:cleanup',
      actor: req.user ? { id: req.user.id, username: req.user.username, role: req.user.role } : null,
      ip,
      after: { removed, kept, retention_days: retention }
    });
    res.json({ success: true, data: { removed, kept, retention_days: retention, errors } });
  })
);

// v5.5.1: 应用版本（前端用，动态注入 header / login 等位置）
systemRouter.get(
  '/version',
  asyncHandler((_req, res) => {
    res.json({
      success: true,
      data: {
        version: getAppVersion(),
        name: getAppName(),
        description: getAppDescription()
      }
    });
  })
);

// 数据维护：compact / backup / archive（仅 admin）
systemRouter.post(
  '/maintenance',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { action, days } = req.body || {};
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!action || !['compact', 'backup', 'archive'].includes(action)) {
      return res.status(400).json({ success: false, error: 'action 必须是 compact/backup/archive' });
    }
    try {
      let result: any;
      if (action === 'compact') {
        result = await storage.compact();
        taskQueue.addLog(
          'success',
          'system',
          `[maintenance] JSONL 压缩完成: 任务 ${result.tasks}, 会话 ${result.sessions}`
        );
      } else if (action === 'backup') {
        result = await storage.backup();
        taskQueue.addLog('success', 'system', `[maintenance] 备份完成: ${result.files.length} 个文件 → ${result.dir}`);
      } else {
        const archiveDays = Math.max(1, parseInt(days, 10) || systemSettings.get().tasks.archive_after_days || 7);
        result = await storage.archiveCompletedTasks(archiveDays);
        taskQueue.addLog(
          'success',
          'system',
          `[maintenance] 归档完成: ${result.archived} 个任务 → ${result.file || '无'}`
        );
      }
      writeAudit({
        action: 'system:maintenance',
        actor: req.user ? { id: req.user.id, username: req.user.username, role: req.user.role } : null,
        ip,
        after: { action, result }
      });
      res.json({ success: true, data: result });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  })
);

// 审计日志查询（仅 admin）
systemRouter.get(
  '/audit',
  requireRole('admin'),
  asyncHandler((req, res) => {
    const { limit, action, actor, since } = req.query;
    const entries = readAudit({
      limit: limit ? parseInt(limit as string, 10) : 100,
      action: action as string | undefined,
      actor: actor as string | undefined,
      since: since ? parseInt(since as string, 10) : undefined
    });
    res.json({ success: true, data: { entries, stats: getAuditStats() } });
  })
);

// v5.5.6: OpenAPI 文档（Swagger UI）
systemRouter.get(
  '/docs',
  asyncHandler((_req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>ai-bridge API 文档</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({ url: '/openapi.json', dom_id: '#swagger-ui' });
  </script>
</body>
</html>`);
  })
);

// v5.4.2: SQLite 状态（表行数 + 文件大小 + 写错误数 + 迁移版本）
systemRouter.get(
  '/sqlite/status',
  asyncHandler((_req, res) => {
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
  })
);

// Skill 安装子路由
systemRouter.use('/skill', skillRouter);
