import { Router } from 'express';
import { taskQueue } from '../task-queue.js';
import { sessionManager } from '../session.js';
import { kbStore } from '../kb-store.js';
import { kbLinkStore } from '../kb-link-store.js';
import { workflowStore } from '../workflow-store.js';
import { storage } from '../storage.js';
import { asyncHandler } from '../middleware/error.js';

/**
 * 心跳路由（合并了原 /health 与 /api/heartbeat 的职责）
 * 目标：让前端一次拿到运行状态 + 队列 + 会话 + KB + 工作流的快照
 *
 * - GET /api/heartbeat  业务状态（前端用，5s 轮询）
 * - GET /api/snapshot   完整快照（仪表盘用）
 */
export const heartbeatRouter = Router();

// ======== 心跳（前端 setInterval(5s) 调用）=======
heartbeatRouter.get('/', asyncHandler((req, res) => {
  const stats = taskQueue.getStats();
  const sessions = sessionManager.listSessions();
  const kbData = kbStore.list();
  const wfList = workflowStore.list();
  const linksData = kbLinkStore.list();

  res.json({
    success: true,
    data: {
      server_time: Date.now(),
      agent_online: true,
      has_urgent_task: stats.pending > 0,
      queue_stats: stats,
      pending_count: stats.pending,
      processing_count: stats.processing,
      sessions: sessions.map(s => ({
        id: s.id,
        name: s.name,
        task_count: s.task_count,
        status: s.status,
        updated_at: s.updated_at
      })),
      default_session_id: sessionManager.getDefaultSessionId(),
      kb_stats: {
        categories: kbData.categories.length,
        items: kbData.items.length,
        links: linksData.total,
        total: kbData.categories.length + kbData.items.length + linksData.total
      },
      wf_stats: {
        workflows: wfList.length,
        total_steps: wfList.reduce((s, w) => s + (w.steps?.length || 0), 0)
      },
      storage: storage.getStorageStats(),
      websocket_clients: (req.app.get('wsClients') as Set<unknown>)?.size ?? 0
    }
  });
}));

// ======== 完整快照（仪表盘调试用）=======
heartbeatRouter.get('/snapshot', asyncHandler((_req, res) => {
  const stats = taskQueue.getStats();
  const sessions = sessionManager.listSessions();
  const kbData = kbStore.list();
  const wfList = workflowStore.list();
  const linksData = kbLinkStore.list();

  res.json({
    success: true,
    data: {
      server_time: Date.now(),
      queue: stats,
      sessions: {
        total: sessions.length,
        active: sessions.filter(s => s.status === 'active').length,
        items: sessions
      },
      kb: {
        categories: kbData.categories,
        items: kbData.items.slice(0, 50), // 截断避免大响应
        items_total: kbData.items.length,
        links: linksData.links
      },
      workflows: wfList,
      storage: storage.getStorageStats()
    }
  });
}));
