/**
 * 概览聚合统计路由（v5.2.0 新增）
 *
 * GET /api/overview/stats
 * - 一次性返回：任务统计 / 成功率 / 知识库 / 工作流 / 会话 / 存储 / 任务趋势 / 来源分布 / 系统健康
 * - 减少前端多次请求，由后端单次聚合
 */

import { Router } from 'express';
import { storage } from '../storage.js';
import { sessionManager } from '../session.js';
import { kbStore } from '../kb-store.js';
import { kbLinkStore } from '../kb-link-store.js';
import { workflowStore } from '../workflow-store.js';
import { clawManager } from '../claw/index.js';
import { clawConfig } from '../claw/config.js';
import * as fs from 'fs';
import * as path from 'path';

export const overviewRouter = Router();

interface DayBucket {
  date: string;
  count: number;
  success: number;
}

overviewRouter.get('/stats', (_req, res) => {
  try {
    // 1. 任务统计
    const allTasks = storage.getAllTasks();
    const tasksByStatus = storage.getCountByStatus();
    const completed = tasksByStatus.completed || 0;
    const failed = tasksByStatus.failed || 0;
    const totalDone = completed + failed;
    const successRate = totalDone > 0 ? Math.round((completed / totalDone) * 100) : null;

    // 2. 知识库
    const kbListResp = kbStore.list();
    const kbLinksTotal = kbLinkStore.list().total;

    // 3. 工作流
    const wfList: any = workflowStore.list();
    const wfArr: any[] = Array.isArray(wfList) ? wfList : (wfList.workflows || []);
    const wfTotalSteps = wfArr.reduce((sum: number, w: any) => sum + (w.steps?.length || 0), 0);

    // 4. 会话
    const sessions = sessionManager.listSessions();
    const activeSessions = sessions.filter(s => s.status === 'active').length;
    const archivedSessions = sessions.filter(s => s.status === 'archived').length;

    // 5. 存储
    const dataDir = path.join(process.cwd(), 'data');
    const storageStats = calcStorageStats(dataDir);

    // 6. 趋势
    const trend = calcTrend(allTasks, 7);

    // 7. 来源分布
    const sourceDist: Record<string, number> = {};
    for (const t of allTasks) {
      sourceDist[t.source] = (sourceDist[t.source] || 0) + 1;
    }

    // 8. 系统健康
    const clawStatus: any = clawManager.getStatus() || {};
    const cfg = clawConfig.get();
    const health = {
      server_uptime_sec: Math.floor(process.uptime()),
      server_time: Date.now(),
      node_version: process.version,
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      claw: {
        enabled: cfg.enabled,
        connected: clawStatus.state === 'logged_in' || clawStatus.connected === true,
        state: clawStatus.state || 'idle',
        wxid: clawStatus.wxid || null
      },
      data_dir: dataDir
    };

    res.json({
      success: true,
      data: {
        tasks: {
          total: allTasks.length,
          pending: tasksByStatus.pending || 0,
          processing: tasksByStatus.processing || 0,
          completed,
          failed,
          success_rate: successRate
        },
        kb: {
          categories: kbListResp.categories.length,
          items: kbListResp.items.length,
          links: kbLinksTotal
        },
        wf: {
          templates: wfArr.length,
          steps: wfTotalSteps
        },
        sessions: {
          total: sessions.length,
          active: activeSessions,
          archived: archivedSessions
        },
        storage: storageStats,
        trend,
        source_dist: sourceDist,
        health
      }
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

function calcStorageStats(dataDir: string) {
  const result = { total_bytes: 0, files: [] as Array<{ name: string; bytes: number; lines: number }> };
  if (!fs.existsSync(dataDir)) return result;
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.jsonl') && !f.startsWith('.'));
  for (const f of files) {
    const fp = path.join(dataDir, f);
    const stat = fs.statSync(fp);
    let lines = 0;
    try {
      const content = fs.readFileSync(fp, 'utf8');
      lines = content ? content.split('\n').filter(l => l.trim()).length : 0;
    } catch {}
    result.files.push({ name: f, bytes: stat.size, lines });
    result.total_bytes += stat.size;
  }
  return result;
}

function calcTrend(tasks: any[], days: number): DayBucket[] {
  const buckets: DayBucket[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    buckets.push({ date: key, count: 0, success: 0 });
  }
  const bucketMap = new Map(buckets.map(b => [b.date, b]));
  for (const t of tasks) {
    if (!t.completed_at) continue;
    const key = new Date(t.completed_at).toISOString().slice(0, 10);
    const b = bucketMap.get(key);
    if (b) {
      b.count++;
      if (t.result?.status === 'success') b.success++;
    }
  }
  return buckets;
}
