// ======== AI 模型配置路由（v5.3.0 新增）========
//
// GET    /api/models             目录：providers + 当前 config + secrets 状态
// GET    /api/models/config      当前用户配置
// PATCH  /api/models/config      局部更新（默认 provider/model、启用列表）
// POST   /api/models/config/reset 恢复默认配置
//
// 注意：API key 等敏感字段不在这里读写，统一在 ~/.config/agent-canvas/secrets.env。

import { Router } from 'express';
import { modelsConfig } from '../lib/models-config.js';
import { taskQueue } from '../task-queue.js';
import { asyncHandler } from '../middleware/error.js';

export const modelRouter = Router();

// 目录（前端首选接口，符合 project_memory 「Model configuration panel must fetch data from /api/models endpoint」）
modelRouter.get('/', asyncHandler((_req, res) => {
  res.json({ success: true, data: modelsConfig.catalog() });
}));

// 当前用户配置
modelRouter.get('/config', asyncHandler((_req, res) => {
  res.json({ success: true, data: modelsConfig.get() });
}));

// 局部更新
modelRouter.patch('/config', asyncHandler((req, res) => {
  const before = modelsConfig.get();
  const updated = modelsConfig.update(req.body || {});
  taskQueue.addLog('info', 'system', `[models] 配置已更新: 默认 ${before.default_provider}/${before.default_model} → ${updated.default_provider}/${updated.default_model}`);
  res.json({ success: true, data: updated });
}));

// 重置为默认
modelRouter.post('/config/reset', asyncHandler((_req, res) => {
  const fresh = modelsConfig.update({
    default_provider: 'deepseek',
    default_model: 'deepseek-chat',
    enabled_providers: ['deepseek'],
    provider_overrides: {}
  });
  taskQueue.addLog('info', 'system', '[models] 已重置为默认配置');
  res.json({ success: true, data: fresh });
}));
