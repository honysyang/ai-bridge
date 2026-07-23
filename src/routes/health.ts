import { Router } from 'express';
import { storage } from '../storage.js';
import { taskQueue } from '../task-queue.js';

/**
 * 健康检查 + 存储管理路由
 * - GET  /health              服务存活 + 存储快照
 * - GET  /api/storage/stats   各 jsonl 文件大小/行数
 * - GET  /api/storage/export  全量导出（备份）
 * - POST /api/storage/import  全量导入（恢复）
 * - POST /api/storage/wipe    清空（危险）
 */
export const healthRouter = Router();
export const storageRouter = Router();

// ======== /health ========
healthRouter.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      bridge: 'running',
      version: '5.0.0',
      websocket_clients: (req.app.get('wsClients') as Set<unknown>)?.size ?? 0,
      storage: storage.getStorageStats(),
      timestamp: Date.now()
    }
  });
});

// ======== /api/storage/* ========
storageRouter.get('/stats', (_req, res) => {
  res.json({ success: true, data: storage.getStorageStats() });
});

storageRouter.get('/export', async (_req, res) => {
  try {
    const data = await storage.exportAll();
    res.json({ success: true, data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

storageRouter.post('/import', async (req, res) => {
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

storageRouter.post('/wipe', async (_req, res) => {
  try {
    await storage.wipeAll();
    taskQueue.addLog('warn', 'bridge', '所有数据已清空');
    res.json({ success: true, message: '已清空' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
